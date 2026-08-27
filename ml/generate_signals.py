#!/usr/bin/env python3
"""
ml/generate_signals.py — Synthetic scalper training signal generator.

⚠️ AUDIT WARNING (Phase 3, item 9): synthetic data is CIRCULAR by construction.
This script applies the *identical* Scalp 5-vote rule engine to generate the
signal AND then labels it with the same TP/SL rule — so a model trained on it
can never outperform the rule it was trained to replicate. The audit
recommended stopping auto-labeling with the same rule being trained.

Preferred path: `python build_dataset.py` → REAL resolved Supabase signals with
consistent SL/TP-first-hit re-labeling. Use --synthetic only as a last-resort
data-augmentation supplement, and expect it to cap model performance at the
rule engine's own accuracy.

Pulls M5 OHLCV from OANDA (primary, unlimited history) or yfinance (fallback,
60-day window), computes every indicator the live system uses, applies the Scalp
5-vote signal logic to every bar, then labels each signal WIN/LOSS using the same
6-candle (30 min) timeout window as app/api/scalper/label/route.ts.

Output: ml/data/synthetic_signals.csv — rows compatible with train.py

Usage:
    cd forex-ai/ml
    source .venv/bin/activate
    python generate_signals.py                        # 180 days, both pairs
    python generate_signals.py --days 365             # 1 year
    python generate_signals.py --pair XAU/USD         # gold only
    python generate_signals.py --source yfinance      # force yfinance fallback
"""

import os, sys, time, argparse, warnings
from datetime import datetime, timezone, timedelta
from typing import Optional
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

warnings.filterwarnings('ignore')

DATA_DIR   = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

_raw_oanda_key = os.environ.get('OANDA_API_KEY', '')
# Treat placeholder values as missing
OANDA_KEY  = _raw_oanda_key if (
    _raw_oanda_key and not _raw_oanda_key.lower().startswith('your_')
) else ''
OANDA_URL  = (os.environ.get('OANDA_BASE_URL') or 'https://api-fxtrade.oanda.com').rstrip('/')

AV_KEY     = os.environ.get('ALPHA_VANTAGE_KEY', '')
AV_KEY     = AV_KEY if (AV_KEY and not AV_KEY.lower().startswith('your_')) else ''

# Signal/label constants — must match label/route.ts and signal/route.ts
CANDLE_WINDOW = 6          # 30-min label window (matches updated CANDLE_WINDOW)
SL_ATR_MULT   = 1.5
TP_ATR_MULT   = 2.5        # matches signal/route.ts slPips * (5/3) → TP = 2.5×ATR

OANDA_PAIRS = {
    'XAU/USD': 'XAU_USD',
    'XAG/USD': 'XAG_USD',
}

# ─── OANDA M5 fetch ───────────────────────────────────────────────────────────

def _oanda_headers():
    return {
        'Authorization': f'Bearer {OANDA_KEY}',
        'Content-Type': 'application/json',
    }


def fetch_m5_oanda(pair: str, days: int) -> Optional[pd.DataFrame]:
    """Fetch up to `days` of M5 candles for `pair` from OANDA v20 REST API."""
    import requests

    instrument = OANDA_PAIRS.get(pair)
    if not instrument:
        print(f"  ✗  Unsupported pair for OANDA: {pair}")
        return None
    if not OANDA_KEY:
        print("  ✗  OANDA_API_KEY not set — falling back to yfinance")
        return None

    print(f"  OANDA ▸ {instrument} M5  ({days}d window)")
    url    = f'{OANDA_URL}/v3/instruments/{instrument}/candles'
    end_dt = datetime.now(timezone.utc)
    from_dt = end_dt - timedelta(days=days)

    all_candles = []
    batch_end   = end_dt

    while batch_end > from_dt:
        batch_start = max(from_dt, batch_end - timedelta(days=18))  # ~5000 M5 bars per 18 days
        params = {
            'price':        'M',
            'granularity':  'M5',
            'from':         batch_start.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'to':           batch_end.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'count':        5000,
        }
        try:
            resp = requests.get(url, headers=_oanda_headers(), params=params, timeout=30)
            if resp.status_code == 401:
                print("  ✗  OANDA auth failed — check OANDA_API_KEY")
                return None
            if resp.status_code == 404:
                print(f"  ✗  OANDA instrument not found: {instrument}  (account may not have gold/silver)")
                return None
            resp.raise_for_status()
            candles = resp.json().get('candles', [])
            if not candles:
                break
            all_candles.extend(candles)
            oldest = datetime.fromisoformat(candles[0]['time'].replace('Z', '+00:00'))
            print(f"    batch {len(all_candles):>6} candles  oldest={oldest.date()}")
            batch_end = oldest - timedelta(seconds=1)
            if len(candles) < 100:
                break
            time.sleep(0.1)
        except requests.exceptions.RequestException as e:
            print(f"  ⚠  OANDA request failed: {e}")
            break

    if not all_candles:
        print(f"  ✗  No candles returned from OANDA for {instrument}")
        return None

    rows = []
    for c in all_candles:
        if not c.get('complete', True):
            continue
        mid = c.get('mid', {})
        rows.append({
            'time':   c['time'],
            'open':   float(mid.get('o', 0)),
            'high':   float(mid.get('h', 0)),
            'low':    float(mid.get('l', 0)),
            'close':  float(mid.get('c', 0)),
            'volume': int(c.get('volume', 0)),
        })

    df = pd.DataFrame(rows)
    df['time'] = pd.to_datetime(df['time'], utc=True)
    df = df.sort_values('time').drop_duplicates('time').set_index('time')
    print(f"  ✓  {len(df):,} M5 candles  ({df.index[0].date()} → {df.index[-1].date()})")
    return df


def fetch_m5_yfinance(pair: str, days: int) -> Optional[pd.DataFrame]:
    """
    Fetch M5 data from yfinance — limited to last 60 days.
    Uses Ticker.history() which is less aggressively rate-limited than yf.download().
    Retries up to 3 times with backoff on rate-limit errors.
    """
    try:
        import yfinance as yf
    except ImportError:
        print("  ✗  yfinance not installed — pip install yfinance")
        return None

    YF_MAP = {'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F'}
    sym = YF_MAP.get(pair)
    if not sym:
        return None

    capped = min(days, 59)
    print(f"  yfinance ▸ {sym} M5  ({capped}d, capped at 60d free limit)")

    for attempt in range(1, 4):
        try:
            ticker = yf.Ticker(sym)
            raw = ticker.history(period=f'{capped}d', interval='5m', auto_adjust=True)
            if raw is None or raw.empty:
                raise ValueError("empty result")
            df = raw[['Open', 'High', 'Low', 'Close', 'Volume']].copy()
            df.columns = [c.lower() for c in df.columns]
            df.index = pd.to_datetime(df.index, utc=True)
            df = df.sort_index().dropna()
            print(f"  ✓  {len(df):,} M5 candles  ({df.index[0].date()} → {df.index[-1].date()})")
            return df
        except Exception as e:
            msg = str(e).lower()
            if 'rate' in msg or '429' in msg or 'too many' in msg:
                wait = 20 * attempt
                print(f"  ⚠  yfinance rate-limited (attempt {attempt}/3) — waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  ✗  yfinance failed: {e}")
                return None
    print("  ✗  yfinance: all retries exhausted")
    return None


def fetch_m5_alpha_vantage(pair: str, days: int) -> Optional[pd.DataFrame]:
    """
    Fetch M5 intraday data from Alpha Vantage FX_INTRADAY endpoint.
    Free tier: 25 calls/day, ~last 30 days with outputsize=full.
    Supports XAU (gold) and XAG (silver) as from_symbol.
    """
    if not AV_KEY:
        print("  ✗  ALPHA_VANTAGE_KEY not set or is placeholder")
        return None

    try:
        import requests
    except ImportError:
        return None

    AV_MAP = {'XAU/USD': ('XAU', 'USD'), 'XAG/USD': ('XAG', 'USD')}
    syms = AV_MAP.get(pair)
    if not syms:
        return None

    from_sym, to_sym = syms
    print(f"  Alpha Vantage ▸ {from_sym}/{to_sym} M5  (outputsize=full, ~30d)")

    url = 'https://www.alphavantage.co/query'
    params = {
        'function':    'FX_INTRADAY',
        'from_symbol': from_sym,
        'to_symbol':   to_sym,
        'interval':    '5min',
        'outputsize':  'full',
        'apikey':      AV_KEY,
        'datatype':    'json',
    }
    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        if 'Note' in data:
            print(f"  ⚠  Alpha Vantage rate limit: {data['Note'][:80]}")
            return None
        if 'Information' in data:
            print(f"  ⚠  Alpha Vantage info: {data['Information'][:80]}")
            return None
        if 'Error Message' in data:
            print(f"  ✗  Alpha Vantage error: {data['Error Message'][:80]}")
            return None

        ts_key = 'Time Series FX (5min)'
        raw = data.get(ts_key, {})
        if not raw:
            print(f"  ✗  Alpha Vantage returned no time series data")
            return None

        rows = []
        for ts_str, bar in raw.items():
            rows.append({
                'time':   pd.Timestamp(ts_str, tz='America/New_York').tz_convert('UTC'),
                'open':   float(bar['1. open']),
                'high':   float(bar['2. high']),
                'low':    float(bar['3. low']),
                'close':  float(bar['4. close']),
                'volume': 0,
            })

        df = pd.DataFrame(rows).sort_values('time').set_index('time')
        df = df.dropna()
        print(f"  ✓  {len(df):,} M5 candles  ({df.index[0].date()} → {df.index[-1].date()})")
        return df

    except Exception as e:
        print(f"  ✗  Alpha Vantage failed: {e}")
        return None


# ─── Indicator computation ────────────────────────────────────────────────────

def _wilder_smooth(series: pd.Series, period: int) -> pd.Series:
    """Wilder's smoothed moving average (used for ATR, ADX, DI)."""
    result = series.copy() * np.nan
    mask   = series.notna()
    vals   = series[mask].values
    if len(vals) < period:
        return result
    out = np.full(len(vals), np.nan)
    out[period - 1] = vals[:period].mean()
    alpha = 1.0 / period
    for i in range(period, len(vals)):
        out[i] = out[i - 1] * (1 - alpha) + vals[i] * alpha
    result[mask] = out
    return result


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute all indicators used by the live Scalp signal system.
    Input: DataFrame with columns open/high/low/close/volume (lowercase), time index.
    Output: same DataFrame with indicator columns added.
    """
    c, h, l, o = df['close'], df['high'], df['low'], df['open']

    # ── EMAs
    df['ema9']  = c.ewm(span=9,  adjust=False).mean()
    df['ema21'] = c.ewm(span=21, adjust=False).mean()
    df['ema20'] = c.ewm(span=20, adjust=False).mean()
    df['ema50'] = c.ewm(span=50, adjust=False).mean()

    # ── MACD 12/26/9
    ema12             = c.ewm(span=12, adjust=False).mean()
    ema26             = c.ewm(span=26, adjust=False).mean()
    df['macd_line']   = ema12 - ema26
    df['macd_signal'] = df['macd_line'].ewm(span=9, adjust=False).mean()
    df['macd_hist']   = df['macd_line'] - df['macd_signal']

    # ── RSI(14) and RSI(7) using standard SMMA
    for period, col in ((14, 'rsi14'), (7, 'rsi7')):
        delta = c.diff()
        gain  = delta.clip(lower=0)
        loss  = (-delta.clip(upper=0))
        avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
        rs        = avg_gain / avg_loss.replace(0, np.nan)
        df[col]   = 100 - 100 / (1 + rs)

    # ── Bollinger Bands (20-period, 2σ)
    sma20          = c.rolling(20).mean()
    std20          = c.rolling(20).std()
    df['bb_upper'] = sma20 + 2 * std20
    df['bb_lower'] = sma20 - 2 * std20
    df['bb_mid']   = sma20
    df['bb_width'] = df['bb_upper'] - df['bb_lower']

    # ── ATR(14) — Wilder smoothed True Range
    prev_c      = c.shift(1)
    tr          = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    df['atr14'] = _wilder_smooth(tr, 14)

    # ── ADX(14) — Wilder's method
    up_move   = h.diff()
    down_move = (-l.diff())
    plus_dm   = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm  = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    plus_dm_s  = _wilder_smooth(pd.Series(plus_dm,  index=df.index), 14)
    minus_dm_s = _wilder_smooth(pd.Series(minus_dm, index=df.index), 14)
    atr_s      = df['atr14']
    plus_di    = 100 * plus_dm_s  / atr_s.replace(0, np.nan)
    minus_di   = 100 * minus_dm_s / atr_s.replace(0, np.nan)
    dx         = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    df['adx']  = _wilder_smooth(dx, 14)

    # ── Buy pressure — approximate from bar internals (no tick data available)
    # (close - low) / (high - low) ∈ [0,1]: 1.0 = close at top of bar (strong buying)
    bar_range         = (h - l).replace(0, np.nan)
    df['buy_pressure'] = ((c - l) / bar_range).fillna(0.5)

    return df


# ─── Signal generation (mirrors Scalp strategy in signal/route.ts) ───────────

def generate_signals(df: pd.DataFrame, pair: str) -> pd.DataFrame:
    """
    Apply the Scalp 5-vote majority logic to every bar.
    Returns a DataFrame with: direction, confidence, entry, sl, tp, vote_count.
    Only bars with a clear 3/5 or better majority are included (HOLD rows excluded).
    """
    bb_mid  = df['bb_mid']
    rsi14   = df['rsi14']
    ema9    = df['ema9']
    ema21   = df['ema21']
    macd_h  = df['macd_hist']
    bp      = df['buy_pressure']
    price   = df['close']
    atr     = df['atr14']

    # 5 votes: +1 = bullish, -1 = bearish
    v1 = np.where(rsi14 > 50, 1, -1)
    v2 = np.where(ema9  > ema21, 1, -1)
    v3 = np.where(macd_h > 0, 1, -1)
    v4 = np.where(bp > 0.5, 1, -1)
    v5 = np.where(price > bb_mid, 1, -1)

    bull_votes = (v1 + v2 + v3 + v4 + v5 + 5) // 2  # count of +1 votes (0-5)
    # More accurate: sum then shift
    vote_sum  = v1 + v2 + v3 + v4 + v5  # range -5 to +5
    bull_cnt  = pd.Series((vote_sum + 5) / 2, index=df.index).astype(int).clip(0, 5)
    bear_cnt  = 5 - bull_cnt
    edge      = (bull_cnt - bear_cnt).abs()

    # Direction based on majority
    direction = pd.Series(np.where(bull_cnt >= 3, 'BUY',
                          np.where(bear_cnt >= 3, 'SELL', 'HOLD')), index=df.index)

    # Confidence: same formula as fallbackSignal in signal/route.ts
    raw_score = np.where(
        direction == 'BUY',  55 + edge * 8,
        np.where(direction == 'SELL', 45 - edge * 8, 50)
    )
    confidence = np.where(
        direction == 'SELL',  100 - raw_score,   # normalise SELL confidence
        raw_score
    ).clip(0, 100).astype(int)

    # SL / TP in price units
    sl_dist = atr * SL_ATR_MULT
    tp_dist = atr * TP_ATR_MULT

    sl = np.where(direction == 'BUY',  price - sl_dist,
         np.where(direction == 'SELL', price + sl_dist, price))
    tp = np.where(direction == 'BUY',  price + tp_dist,
         np.where(direction == 'SELL', price - tp_dist, price))

    signals = pd.DataFrame({
        'direction':  direction,
        'confidence': confidence,
        'entry':      price.values,
        'sl':         sl,
        'tp':         tp,
        'atr':        atr.values,
        'adx':        df['adx'].values,
        'rsi14':      rsi14.values,
        'rsi7':       df['rsi7'].values,
        'ema9':       ema9.values,
        'ema21':      ema21.values,
        'ema20':      df['ema20'].values,
        'ema50':      df['ema50'].values,
        'macd_hist':  macd_h.values,
        'macd_line':  df['macd_line'].values,
        'macd_signal':df['macd_signal'].values,
        'bb_upper':   df['bb_upper'].values,
        'bb_lower':   df['bb_lower'].values,
        'bb_width':   df['bb_width'].values,
        'buy_pressure':bp.values,
        'bull_votes': bull_cnt.values,
    }, index=df.index)

    # Drop HOLD and indicator warmup NaNs
    signals = signals[signals['direction'] != 'HOLD'].dropna()
    return signals


# ─── Outcome labeling ─────────────────────────────────────────────────────────

def label_signals(signals: pd.DataFrame, price_df: pd.DataFrame) -> pd.DataFrame:
    """
    For each signal bar, look at the next CANDLE_WINDOW M5 candles:
      BUY : WIN if any high >= tp, LOSS if low <= sl (SL takes priority on same candle)
      SELL: WIN if any low  <= tp, LOSS if high >= sl
    Timeout (no hit within window) → LOSS
    Mirrors app/api/scalper/label/route.ts labelFromCandles logic.
    """
    highs  = price_df['high'].values
    lows   = price_df['low'].values
    times  = price_df.index
    idx_map = {t: i for i, t in enumerate(times)}

    outcomes = []
    for sig_time, row in signals.iterrows():
        start = idx_map.get(sig_time)
        if start is None:
            outcomes.append('LOSS')
            continue

        direction = row['direction']
        sl, tp    = row['sl'], row['tp']
        outcome   = 'LOSS'   # default: timeout

        window_end = min(start + CANDLE_WINDOW + 1, len(highs))
        for i in range(start + 1, window_end):
            if direction == 'BUY':
                if lows[i] <= sl:
                    outcome = 'LOSS'; break
                if highs[i] >= tp:
                    outcome = 'WIN';  break
            else:  # SELL
                if highs[i] >= sl:
                    outcome = 'LOSS'; break
                if lows[i] <= tp:
                    outcome = 'WIN';  break

        outcomes.append(outcome)

    signals = signals.copy()
    signals['outcome'] = outcomes
    return signals


# ─── Build indicator_snapshot dict ───────────────────────────────────────────

def to_snapshot(row: pd.Series, pair: str) -> dict:
    """Convert a signal row to the indicator_snapshot JSON format train.py expects."""
    return {
        'currentPrice':   row['entry'],
        'rsi14':          row['rsi14'],
        'rsi7':           row['rsi7'],
        'macdHistogram':  row['macd_hist'],
        'macdLine':       row['macd_line'],
        'macdSignal':     row['macd_signal'],
        'ema9':           row['ema9'],
        'ema21':          row['ema21'],
        'ema20':          row['ema20'],
        'ema50':          row['ema50'],
        'bbUpper':        row['bb_upper'],
        'bbLower':        row['bb_lower'],
        'bbWidth':        row['bb_width'],
        'adx':            row['adx'],
        'atr':            row['atr'],
        'buyPressure':    row['buy_pressure'],
        'scalper': {
            'rsi7':        row['rsi7'],
            'ema9':        row['ema9'],
            'ema21':       row['ema21'],
            'buyPressure': row['buy_pressure'],
            'atr':         row['atr'],
        },
        '_computed': {
            'entry': row['entry'],
            'sl':    row['sl'],
            'tp':    row['tp'],
        },
        '_synthetic': True,   # flag so we know this didn't come from the live EA
    }


# ─── Main pipeline ────────────────────────────────────────────────────────────

def run(pairs: list, days: int, source: str, out_path: str):
    print(f"\n{'═'*60}")
    print(f"  Synthetic Signal Generator")
    print(f"  Pairs: {pairs}  |  Window: {days}d  |  Source: {source}")
    print(f"{'═'*60}\n")

    all_rows = []

    for pair in pairs:
        print(f"\n── {pair} ──────────────────────────────────────────")

        # 1. Fetch M5 data
        df = None
        if source in ('oanda', 'auto'):
            df = fetch_m5_oanda(pair, days)
        if df is None or df.empty:
            df = fetch_m5_yfinance(pair, days)
        if df is None or df.empty:
            df = fetch_m5_alpha_vantage(pair, days)
        if df is None or df.empty:
            print(f"  ✗  No data for {pair} — skipping")
            continue

        # 2. Compute indicators
        print(f"  🔧 Computing indicators on {len(df):,} bars...")
        df = compute_indicators(df)

        # 3. Generate signals
        print(f"  🎯 Generating signals...")
        signals = generate_signals(df, pair)
        print(f"     {len(signals):,} signal bars  ({signals['direction'].value_counts().to_dict()})")

        # 4. Label
        print(f"  🏷  Labeling outcomes (±{CANDLE_WINDOW} candle window)...")
        signals = label_signals(signals, df)
        win_rate = (signals['outcome'] == 'WIN').mean()
        print(f"     WIN: {(signals['outcome']=='WIN').sum()}  "
              f"LOSS: {(signals['outcome']=='LOSS').sum()}  "
              f"win_rate={win_rate:.1%}")

        # 5. Session win-rate report
        print(f"\n  📊 Session win-rate breakdown:")
        for h_lo, h_hi, label in (
            (22, 6,  'Asian  22-06'),
            (7,  12, 'London 07-12'),
            (13, 16, 'NY+LON 13-16'),
            (17, 21, 'NY     17-21'),
        ):
            hour  = signals.index.tz_convert('UTC').hour if signals.index.tz else signals.index.hour
            if h_lo <= h_hi:
                mask = (hour >= h_lo) & (hour < h_hi)
            else:
                mask = (hour >= h_lo) | (hour < h_hi)
            sub = signals[mask]
            if len(sub) == 0:
                continue
            for d in ('BUY', 'SELL'):
                s = sub[sub['direction'] == d]
                if len(s) == 0:
                    continue
                wr = (s['outcome'] == 'WIN').mean()
                print(f"     {label} {d:4s}: {wr:5.1%}  n={len(s)}")

        # 6. Build output rows (train.py compatible)
        import json
        for ts, row in signals.iterrows():
            snap = to_snapshot(row, pair)
            all_rows.append({
                'pair':               pair,
                'timeframe':          'synthetic',
                'direction':          row['direction'],
                'confidence':         int(row['confidence']),
                'outcome':            row['outcome'],
                'indicator_snapshot': json.dumps(snap),
                'created_at':         ts.isoformat(),
            })

    if not all_rows:
        print("\n✗  No signals generated — check data sources and credentials.")
        sys.exit(1)

    out_df = pd.DataFrame(all_rows)
    out_df.to_csv(out_path, index=False)
    print(f"\n{'═'*60}")
    print(f"  ✓  {len(out_df):,} synthetic signals → {out_path}")
    print(f"     BUY: {(out_df['direction']=='BUY').sum():,}  "
          f"SELL: {(out_df['direction']=='SELL').sum():,}  "
          f"WIN: {(out_df['outcome']=='WIN').sum():,}  "
          f"LOSS: {(out_df['outcome']=='LOSS').sum():,}")
    print(f"     Overall win rate: {(out_df['outcome']=='WIN').mean():.1%}")
    print(f"\n  Next: python train.py --synthetic {out_path}")
    print(f"{'═'*60}\n")


# ─── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Generate synthetic scalper training signals from M5 OHLCV data'
    )
    parser.add_argument('--days',   type=int, default=180,
                        help='Days of M5 history to fetch (default: 180)')
    parser.add_argument('--pair',   default='',
                        help='Specific pair, e.g. XAU/USD. Omit for all pairs.')
    parser.add_argument('--source', choices=['oanda', 'yfinance', 'auto'], default='auto',
                        help='Data source (default: auto — OANDA first, yfinance fallback)')
    parser.add_argument('--out',    default=os.path.join(DATA_DIR, 'synthetic_signals.csv'),
                        help='Output CSV path')
    args = parser.parse_args()

    pairs = [args.pair] if args.pair else ['XAU/USD', 'XAG/USD']
    run(pairs=pairs, days=args.days, source=args.source, out_path=args.out)
