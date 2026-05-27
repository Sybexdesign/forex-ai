#!/usr/bin/env python3
"""
ml/market_data.py — External market data pipeline for XGBoost training.

Pulls daily OHLCV for gold & silver from yfinance (primary) and Alpha Vantage
(secondary gap-fill), engineers features, and returns time-split numpy arrays
ready to feed into the existing XGBoost model.

Usage — standalone:
    python ml/market_data.py
    python ml/market_data.py --av-key YOUR_KEY
    python ml/market_data.py --av-key YOUR_KEY --start 2015-01-01

Usage — imported:
    from market_data import build_splits
    X_train, X_test, y_train, y_test, feature_names = build_splits(av_key="...")
"""

import os
import sys
import argparse
import warnings
from typing import Optional, Tuple, List
import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')

START_DATE  = '2010-01-01'
TRAIN_RATIO = 0.80
MAX_FFILL   = 3   # max consecutive days to forward-fill (weekends / holidays)


# ─── 1. yfinance download ─────────────────────────────────────────────────────

def _fetch_yfinance(start: str) -> dict:
    try:
        import yfinance as yf
    except ImportError:
        raise ImportError("Missing dependency — run:  pip install yfinance")

    import time

    ALL_SYMS    = ['GC=F', 'SI=F', 'GLD', 'SLV']
    SYM_META    = {
        'GC=F': ('gold',   'futures'),
        'SI=F': ('silver', 'futures'),
        'GLD':  ('gold',   'etf'),
        'SLV':  ('silver', 'etf'),
    }
    MAX_RETRIES = 3
    RETRY_WAIT  = 15   # seconds between retries on rate-limit

    # Download all four tickers in a single batch request (fewer round-trips)
    print(f"  yfinance ▸ batch download: {', '.join(ALL_SYMS)}")
    raw_all = None
    for attempt in range(1, MAX_RETRIES + 1):
        raw_all = yf.download(
            tickers=ALL_SYMS,
            start=start,
            progress=False,
            auto_adjust=True,
            group_by='ticker',
        )
        if raw_all is not None and not raw_all.empty:
            break
        if attempt < MAX_RETRIES:
            print(f"    ⚠  Rate-limited or empty — waiting {RETRY_WAIT}s (attempt {attempt}/{MAX_RETRIES})")
            time.sleep(RETRY_WAIT)
    else:
        print("    ✗  yfinance batch failed after retries — returning empty")
        return {'gold': pd.DataFrame(), 'silver': pd.DataFrame()}

    buckets: dict = {'gold': {}, 'silver': {}}

    for sym in ALL_SYMS:
        metal, kind = SYM_META[sym]
        try:
            if sym in raw_all.columns.get_level_values(0):
                df = raw_all[sym][['Open', 'High', 'Low', 'Close', 'Volume']].copy()
            else:
                # Single-ticker fallback (happens when only one ticker requested)
                df = raw_all[['Open', 'High', 'Low', 'Close', 'Volume']].copy()
            df = df.dropna(how='all')
            if df.empty:
                print(f"    ⚠  {sym} empty after extraction — skipped")
                continue
            df.index = pd.to_datetime(df.index).tz_localize(None)
            df.index.name = 'Date'
            df.columns.name = None
            print(f"    ✓  {sym:6s} ({metal} {kind}): {len(df):,} rows  "
                  f"({df.index[0].date()} → {df.index[-1].date()})")
            buckets[metal][kind] = df
        except Exception as exc:
            print(f"    ⚠  {sym} extraction failed: {exc} — skipped")

    result: dict = {}
    for metal in ('gold', 'silver'):
        futures = buckets[metal].get('futures')
        etf     = buckets[metal].get('etf')

        if futures is None:
            result[metal] = etf.copy() if etf is not None else pd.DataFrame()
            continue

        primary = futures.copy()
        if etf is not None:
            missing = primary.index[primary['Close'].isna()]
            if not missing.empty:
                primary.update(etf.reindex(missing))
        result[metal] = primary

    return result   # {'gold': df, 'silver': df}


# ─── 2. Alpha Vantage download ────────────────────────────────────────────────

def _fetch_alpha_vantage(av_key: str) -> dict:
    try:
        from alpha_vantage.timeseries import TimeSeries
    except ImportError:
        raise ImportError("Missing dependency — run:  pip install alpha_vantage")

    AV_COL_MAP = {
        '1. open':   'Open',
        '2. high':   'High',
        '3. low':    'Low',
        '4. close':  'Close',
        '5. volume': 'Volume',
    }

    ts = TimeSeries(key=av_key, output_format='pandas')
    result: dict = {}

    for metal, symbol in (('gold', 'GLD'), ('silver', 'SLV')):
        print(f"  alpha_vantage ▸ {symbol}  ({metal} ETF, full history)")
        try:
            df, _ = ts.get_daily(symbol=symbol, outputsize='full')
            df = df.rename(columns=AV_COL_MAP)[list(AV_COL_MAP.values())].astype(float)
            df.index = pd.to_datetime(df.index).tz_localize(None)
            df.index.name = 'Date'
            df.sort_index(inplace=True)
            result[metal] = df
        except Exception as exc:
            print(f"    ⚠  Alpha Vantage {symbol} failed: {exc}")

    return result   # {'gold': df, 'silver': df}  (partial if some failed)


# ─── 3. Merge ─────────────────────────────────────────────────────────────────

def _merge(primary: pd.DataFrame, secondary: Optional[pd.DataFrame]) -> pd.DataFrame:
    """yfinance wins on any date that exists in both sources."""
    if secondary is None or secondary.empty:
        return primary.copy()

    gap_dates = secondary[~secondary.index.isin(primary.index)]
    merged    = pd.concat([primary, gap_dates]).sort_index()
    merged    = merged[~merged.index.duplicated(keep='first')]
    return merged


# ─── 4. Clean ─────────────────────────────────────────────────────────────────

def _clean(df: pd.DataFrame, label: str) -> pd.DataFrame:
    df = df.copy()

    for col in ('Open', 'High', 'Low', 'Close', 'Volume'):
        df[col] = pd.to_numeric(df[col], errors='coerce').astype(float)

    before = len(df)
    df.dropna(subset=['Open', 'High', 'Low', 'Close', 'Volume'], how='all', inplace=True)
    dropped = before - len(df)
    if dropped:
        print(f"  {label}: dropped {dropped} all-NaN rows → {len(df)} remain")

    df.ffill(limit=MAX_FFILL, inplace=True)

    # Log gaps that survived forward-fill
    nan_runs = df['Close'].isna()
    if nan_runs.any():
        run_starts = df.index[nan_runs & ~nan_runs.shift(1, fill_value=False)]
        for gs in run_starts:
            future_ok = ~nan_runs[df.index >= gs]
            end_idx   = future_ok.idxmax() if future_ok.any() else df.index[-1]
            days      = (end_idx - gs).days
            print(f"  ⚠  {label}: gap longer than {MAX_FFILL}d  "
                  f"({gs.date()} → {end_idx.date()}, {days}d) — unconditional ffill applied")
        df.ffill(inplace=True)

    return df


# ─── 5. Feature engineering ───────────────────────────────────────────────────

def _engineer(gold: pd.DataFrame, silver: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Add all required features to aligned gold/silver DataFrames.
    Returns (gold_featured, silver_featured).
    """
    common = gold.index.intersection(silver.index)
    g = gold.reindex(common).copy()
    s = silver.reindex(common).copy()

    gs_ratio = g['Close'] / s['Close'].replace(0, np.nan)

    for df in (g, s):
        c = df['Close']

        # ── Returns
        df['daily_return'] = c.pct_change()
        df['return_5d']    = c.pct_change(5)
        df['return_20d']   = c.pct_change(20)

        # ── Moving averages
        for w in (10, 20, 50, 200):
            df[f'SMA_{w}'] = c.rolling(w).mean()

        # ── Volatility (rolling std of daily returns)
        for w in (10, 20):
            df[f'vol_{w}d'] = df['daily_return'].rolling(w).std()

        # ── RSI-14
        delta = c.diff()
        gain  = delta.clip(lower=0).rolling(14).mean()
        loss  = (-delta.clip(upper=0)).rolling(14).mean()
        df['RSI_14'] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))

        # ── MACD 12/26/9
        ema12 = c.ewm(span=12, adjust=False).mean()
        ema26 = c.ewm(span=26, adjust=False).mean()
        df['MACD_line']      = ema12 - ema26
        df['MACD_signal']    = df['MACD_line'].ewm(span=9, adjust=False).mean()
        df['MACD_histogram'] = df['MACD_line'] - df['MACD_signal']

        # ── Bollinger Bands (20-period, 2 std)
        sma20 = c.rolling(20).mean()
        std20 = c.rolling(20).std()
        df['BB_upper'] = sma20 + 2 * std20
        df['BB_lower'] = sma20 - 2 * std20
        df['BB_width'] = (df['BB_upper'] - df['BB_lower']) / sma20.replace(0, np.nan)

        # ── Volume features
        vol_sma = df['Volume'].rolling(20).mean()
        df['vol_SMA_20'] = vol_sma
        df['vol_ratio']  = df['Volume'] / vol_sma.replace(0, np.nan)

        # ── Gold / Silver ratio (same value on both assets)
        df['gs_ratio'] = gs_ratio

        # ── Lagged features
        for lag in (1, 2, 3, 5):
            df[f'close_lag{lag}']  = c.shift(lag)
            df[f'return_lag{lag}'] = df['daily_return'].shift(lag)

        # ── Target: 1 if next-day Close > today's Close
        df['target'] = (c.shift(-1) > c).astype(int)

    return g, s


# ─── 6. Build splits (public API) ────────────────────────────────────────────

_EXCLUDE = frozenset(['Open', 'High', 'Low', 'Close', 'Volume', 'target'])


def build_splits(
    av_key: Optional[str] = None,
    start:  str           = START_DATE,
) -> tuple:
    """
    Full pipeline: download → merge → clean → engineer → time-split.

    Returns
    -------
    X_train, X_test, y_train, y_test : np.ndarray
        Ready to pass directly to model.fit / model.predict.
    feature_names : list[str]
        Ordered feature column names matching X columns.
    """
    print("\n" + "═" * 58)
    print("  Gold & Silver Market Data Pipeline")
    print("═" * 58 + "\n")

    # ── Download
    print("📥  Downloading yfinance (primary)...")
    yf_data = _fetch_yfinance(start)

    av_data: dict = {}
    if av_key:
        print("\n📥  Downloading Alpha Vantage (gap-fill)...")
        av_data = _fetch_alpha_vantage(av_key)
    else:
        print("\n  Alpha Vantage key not provided — yfinance only\n"
              "  (pass --av-key YOUR_KEY to enable secondary source)")

    # ── Merge
    print("\n🔀  Merging sources...")
    gold_raw   = _merge(yf_data.get('gold',   pd.DataFrame()),
                        av_data.get('gold'))
    silver_raw = _merge(yf_data.get('silver', pd.DataFrame()),
                        av_data.get('silver'))

    for label, df in (('gold', gold_raw), ('silver', silver_raw)):
        if df.empty:
            print(f"  ✗  No {label} data available — aborting")
            sys.exit(1)
        av_rows = len(av_data.get(label, pd.DataFrame()))
        print(f"  {label:6s}: {len(df):,} rows  "
              f"({df.index[0].date()} → {df.index[-1].date()})  "
              f"[av gap-fill: {av_rows} rows available]")

    # ── Clean
    print("\n🧹  Cleaning...")
    gold_clean   = _clean(gold_raw,   'gold')
    silver_clean = _clean(silver_raw, 'silver')

    # ── Feature engineering
    print("\n🔧  Engineering features...")
    gold_feat, silver_feat = _engineer(gold_clean, silver_clean)

    # Tag asset, combine, and sort chronologically
    gold_feat['_asset']   = 0   # 0 = gold
    silver_feat['_asset'] = 1   # 1 = silver
    combined = pd.concat([gold_feat, silver_feat]).sort_index()

    # Drop NaN rows produced by rolling windows and lag shifts (also drops last row)
    before_drop = len(combined)
    combined.dropna(inplace=True)
    print(f"  Dropped {before_drop - len(combined):,} NaN rows from rolling/lag periods "
          f"→ {len(combined):,} usable rows")

    feature_cols = [c for c in combined.columns
                    if c not in _EXCLUDE and not c.startswith('_')]

    X      = combined[feature_cols].values.astype(float)
    y      = combined['target'].values.astype(int)
    dates  = combined.index

    # ── Time-based 80/20 split (no shuffle — preserves temporal order)
    cut         = int(len(X) * TRAIN_RATIO)
    X_train     = X[:cut];    X_test  = X[cut:]
    y_train     = y[:cut];    y_test  = y[cut:]
    train_dates = dates[:cut]; test_dates = dates[cut:]

    # ── Report
    print("\n" + "═" * 58)
    print("  DATA SPLITS READY")
    print("═" * 58)
    print(f"\n  X_train  shape : {X_train.shape}")
    print(f"  X_test   shape : {X_test.shape}")
    print(f"  y_train  shape : {y_train.shape}")
    print(f"  y_test   shape : {y_test.shape}")
    print(f"\n  Train date range : {train_dates[0].date()} → {train_dates[-1].date()}")
    print(f"  Test  date range : {test_dates[0].date()}  → {test_dates[-1].date()}")
    print(f"\n  Win rate — train : {y_train.mean():.1%}  |  test : {y_test.mean():.1%}")
    print(f"\n  Features ({len(feature_cols)}):")
    for i, name in enumerate(feature_cols, 1):
        print(f"    {i:>3}. {name}")
    print()

    return X_train, X_test, y_train, y_test, feature_cols


# ─── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Prepare gold/silver splits for XGBoost training'
    )
    parser.add_argument(
        '--av-key',
        default=os.environ.get('ALPHA_VANTAGE_KEY', ''),
        help='Alpha Vantage API key (optional)',
    )
    parser.add_argument(
        '--start',
        default=START_DATE,
        help='History start date YYYY-MM-DD  (default: %(default)s)',
    )
    args = parser.parse_args()

    build_splits(
        av_key=args.av_key or None,
        start=args.start,
    )
