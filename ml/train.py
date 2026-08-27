#!/usr/bin/env python3
"""
ml/train.py — Train XGBoost on Supabase signal data + optional synthetic signals.

Usage:
    python train.py                                        # Supabase only
    python train.py --synthetic data/synthetic_signals.csv # merge synthetic data
    python train.py --synthetic-only data/synthetic_signals.csv  # skip Supabase

Generate synthetic signals first:
    python generate_signals.py --days 365
"""

import os
import sys
import json
import argparse
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import classification_report, roc_auc_score, accuracy_score
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_predict
from supabase import create_client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

# ─── CLI args ─────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description='Train XGBoost scalper model')
parser.add_argument('--synthetic', default='',
                    help='Path to synthetic_signals.csv from generate_signals.py (merged with Supabase)')
parser.add_argument('--synthetic-only', default='',
                    help='Use ONLY synthetic data (skip Supabase fetch)')
parser.add_argument('--dataset', default='',
                    help='Path to clean_dataset.csv from build_dataset.py (preferred; supersedes Supabase fetch)')
parser.add_argument('--calibration', default='sigmoid', choices=['sigmoid', 'isotonic', 'none'],
                    help='Probability calibration method (Phase 3, item 10). sigmoid=Platt, isotonic, none')
parser.add_argument('--min-oos-auc', type=float, default=0.52,
                    help='Walk-forward OOS AUC acceptance gate (Phase 3, item 12). Refuses to overwrite the '
                         'production model when the honest OOS AUC is below this, unless --force is given.')
parser.add_argument('--force', action='store_true',
                    help='Overwrite the production model even when the OOS AUC gate fails.')
parser.add_argument('--min-regime-samples', type=int, default=1000,
                    help='Minimum samples required to train a regime-specific model (Phase 3, item 11).')
args = parser.parse_args()

# ─── Config ───────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ['NEXT_PUBLIC_SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
MODEL_DIR    = os.path.join(os.path.dirname(__file__), 'model')
os.makedirs(MODEL_DIR, exist_ok=True)

PIP_VALUES = {
    'EUR/USD': 0.0001, 'GBP/USD': 0.0001, 'AUD/USD': 0.0001,
    'USD/CAD': 0.0001, 'USD/CHF': 0.0001, 'NZD/USD': 0.0001,
    'USD/JPY': 0.01,   'GBP/JPY': 0.01,   'EUR/JPY': 0.01,
    'XAU/USD': 0.1,    'XAG/USD': 0.01,
}

ALL_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD',
             'USD/CHF', 'NZD/USD', 'XAU/USD', 'XAG/USD']

sb       = create_client(SUPABASE_URL, SUPABASE_KEY)
all_rows = []

# ─── Fetch data ───────────────────────────────────────────────────────────────

if args.dataset:
    # Phase 3 (item 9): prefer the clean labeled dataset built by
    # ml/build_dataset.py. It applies consistent re-labeling (SL/TP-first-hit
    # against live candles) and drops contaminated/gated rows, so the model is
    # trained on trustworthy labels instead of whatever outcome a legacy path
    # happened to write.
    if not os.path.exists(args.dataset):
        print(f"✗ Clean dataset not found: {args.dataset}")
        print("  Run: python build_dataset.py  (or use the default Supabase path)")
        sys.exit(1)
    ds = pd.read_csv(args.dataset)
    print(f"✓ Clean dataset loaded: {len(ds)} rows from {args.dataset}")
    for _, row in ds.iterrows():
        snap = row.get('indicator_snapshot', '{}')
        if isinstance(snap, str):
            try:
                snap = json.loads(snap)
            except Exception:
                snap = {}
        all_rows.append({
            'indicator_snapshot': snap,
            'direction':          row.get('direction', 'HOLD'),
            'confidence':         int(row.get('confidence', 50)),
            'outcome':            row.get('outcome', 'LOSS'),
            'pair':               row.get('pair', 'XAU/USD'),
            'timeframe':          row.get('timeframe', 'clean-dataset'),
            'created_at':         row.get('created_at', '2026-01-01T00:00:00+00:00'),
            '_regime':            row.get('regime', ''),
        })
    print(f"✓ Clean dataset rows staged: {len(all_rows)}")
elif not args.synthetic_only:
    page_size = 1000
    offset    = 0
    while True:
        resp = (
            sb.table('signals')
              .select('indicator_snapshot, direction, confidence, outcome, pair, timeframe, created_at')
              .in_('outcome', ['WIN', 'LOSS'])
              .range(offset, offset + page_size - 1)
              .execute()
        )
        rows = resp.data
        if not rows:
            break
        all_rows.extend(rows)
        offset += page_size
        print(f"  Fetched {len(all_rows)} rows...")
    print(f"✓ Supabase rows with WIN/LOSS outcome: {len(all_rows)}")
else:
    print("⏭  Supabase fetch skipped (--synthetic-only mode)")

# Only train on signals from periods where the direction logic was correct.
# Dates with >50% WIN rate are considered clean; all others are contaminated
# by the inverted-vote bug that was active before 2026-06-01T14:00 UTC.
# Clean periods confirmed by WIN rate analysis:
#   2026-05-15:          77% WIN — clean historical data
#   2026-06-01 14:00+:   ~60% WIN — post-fix data
# Everything else (2026-05-14, 21, 22, 25 and June 1 morning) is excluded.
from datetime import datetime, timezone
import re as _re

def _parse_ts(ts: str) -> datetime:
    ts = _re.sub(r'\.\d+', '', ts)
    ts = _re.sub(r'[+-]\d{2}:\d{2}$', '', ts).replace('Z', '').strip()
    return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)

def _is_clean(ts_str: str) -> bool:
    # Synthetic signals are always clean — they don't carry the inversion-era bug
    # Supabase signals are restricted to confirmed-clean periods only
    dt = _parse_ts(ts_str)
    date = dt.date()
    from datetime import date as ddate
    if date == ddate(2026, 5, 15):
        return True
    if date == ddate(2026, 6, 1) and dt.hour >= 14:
        return True
    # Accept any signal from June 2 onwards (post-fix era)
    if dt >= datetime(2026, 6, 2, 0, 0, tzinfo=timezone.utc):
        return True
    return False

before = len(all_rows)
all_rows = [r for r in all_rows if _is_clean(r['created_at'])]
removed = before - len(all_rows)
print(f"✓ Removed {removed} contaminated Supabase signals (inverted-direction era)")
print(f"✓ Clean Supabase set: {len(all_rows)} rows (May 15 + June 1 14:00+)")

# ─── Merge synthetic signals ──────────────────────────────────────────────────
# Synthetic rows from generate_signals.py have the same schema as Supabase rows.
# indicator_snapshot is stored as a JSON string in the CSV; parse it back to dict.

synthetic_path = args.synthetic or args.synthetic_only
if synthetic_path:
    if not os.path.exists(synthetic_path):
        print(f"✗ Synthetic file not found: {synthetic_path}")
        sys.exit(1)
    syn_df = pd.read_csv(synthetic_path)
    syn_rows = []
    for _, row in syn_df.iterrows():
        snap = row.get('indicator_snapshot', '{}')
        if isinstance(snap, str):
            try:
                snap = json.loads(snap)
            except Exception:
                snap = {}
        syn_rows.append({
            'indicator_snapshot': snap,
            'direction':          row.get('direction', 'HOLD'),
            'confidence':         int(row.get('confidence', 50)),
            'outcome':            row.get('outcome', 'LOSS'),
            'pair':               row.get('pair', 'XAU/USD'),
            'timeframe':          'synthetic',
            'created_at':         row.get('created_at', '2026-01-01T00:00:00+00:00'),
        })
    print(f"✓ Synthetic signals loaded: {len(syn_rows)} rows from {synthetic_path}")
    all_rows.extend(syn_rows)
    print(f"✓ Combined training set: {len(all_rows)} rows "
          f"(Supabase + synthetic)")
else:
    print("  ℹ  No synthetic data — training on Supabase signals only")
    print("     Tip: python generate_signals.py --days 365 to add 50k+ historical bars")

def add_session_feature(row: dict) -> dict:
    """
    Add 4-bucket session one-hot features derived from created_at UTC hour.
    Session regimes derived from XAU/USD win-rate audit (1,139 resolved signals):
      Asian  22-06 UTC: BUY 0%,  SELL 100% — bear regime
      London 07-12 UTC: BUY 0%,  SELL 100% — bear regime
      NY+LON 13-16 UTC: BUY 100%, SELL 0%  — bull regime
      NY     17-21 UTC: BUY 4%,  SELL 87%  — bear regime
    Binary in_session was too coarse to capture these distinct regimes.
    """
    try:
        dt   = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        hour = dt.astimezone(timezone.utc).hour
        row['_hour'] = hour
    except Exception:
        hour = 12
        row['_hour'] = 12

    row['_session_asian']  = 1 if (hour >= 22 or hour < 7)  else 0
    row['_session_london'] = 1 if (7  <= hour < 13)         else 0
    row['_session_nylon']  = 1 if (13 <= hour < 17)         else 0
    row['_session_ny']     = 1 if (17 <= hour < 22)         else 0
    # Keep legacy in_session for backwards compat with existing model (will be ignored if not in features)
    row['_in_session'] = 1 if (hour < 5 or hour >= 19) else 0
    return row

all_rows = [add_session_feature(r) for r in all_rows]
print(f"✓ Using all {len(all_rows)} rows for training (no pre-filtering)")

MIN_ROWS = 20
if len(all_rows) < MIN_ROWS:
    print(f"❌ Need at least {MIN_ROWS} filtered signals to train.")
    exit(1)
if len(all_rows) < 100:
    print(f"⚠  Only {len(all_rows)} filtered signals — model will be weak. Aim for 200+ for production quality.")

df = pd.DataFrame(all_rows)

# ─── Feature extraction ───────────────────────────────────────────────────────

print("🔧 Engineering features...")


def extract_features(row):
    snap = row.get('indicator_snapshot', {})
    if not snap or not isinstance(snap, dict):
        return None

    scalper  = snap.get('scalper', {})
    pair     = row.get('pair', 'EUR/USD')
    pip_val  = PIP_VALUES.get(pair, 0.0001)
    price    = snap.get('currentPrice', 0) or snap.get('price', 0)
    bb_upper = snap.get('bbUpper', 0)
    bb_lower = snap.get('bbLower', 0)
    bb_range = bb_upper - bb_lower if bb_upper > bb_lower else 1
    atr      = scalper.get('atr', snap.get('atr', 0.0005)) or 0.0005

    hour = 12
    try:
        from datetime import datetime, timezone
        dt   = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        hour = dt.hour
    except Exception:
        pass

    rsi   = snap.get('rsi', snap.get('rsi14', 50)) or 50
    ema9  = scalper.get('ema9',  snap.get('ema9',  price)) or price
    ema21 = scalper.get('ema21', snap.get('ema21', price)) or price
    ema20 = snap.get('ema20', price) or price
    ema50 = snap.get('ema50', price) or price
    macd_hist = snap.get('macdHistogram', 0) or 0
    buy_pres  = scalper.get('buyPressure', snap.get('buyPressure', 0.5)) or 0.5

    # Normalise all price-scale values by ATR so features are invariant to
    # absolute price level. Raw EMA and MACD prices are removed — the model
    # would memorise "EMA was at X today = WIN" which never generalises.
    return {
        # Oscillators (already 0-100 or bounded)
        'rsi':               rsi,
        'rsi7':              scalper.get('rsi7', snap.get('rsi7', 50)) or 50,
        'adx':               snap.get('adx', 20) or 20,
        'buy_pressure':      buy_pres,
        # ATR-normalised MACD (removes price-level dependency)
        'macd_hist_atr':     macd_hist / atr if atr > 0 else 0,
        'macd_line_atr':     (snap.get('macdLine', 0) or 0) / atr if atr > 0 else 0,
        'macd_signal_atr':   (snap.get('macdSignal', 0) or 0) / atr if atr > 0 else 0,
        # Price-relative BB width
        'bb_width_rel':      (snap.get('bbWidth', 0.002) or 0.002) / price if price > 0 else 0,
        # EMA ratios (normalised, not absolute prices)
        'ema9_vs_ema21':     (ema9 - ema21) / atr if atr > 0 else 0,
        'price_vs_ema20':    (price - ema20) / atr if atr > 0 else 0,
        'price_vs_ema50':    (price - ema50) / atr if atr > 0 else 0,
        # Binary / categorical (already scale-invariant)
        'rsi_zone':          1 if rsi < 30 else (-1 if rsi > 70 else 0),
        'macd_positive':     1 if macd_hist > 0 else 0,
        'ema_bullish':       1 if ema9 > ema21 else 0,
        'bb_position':       (price - bb_lower) / bb_range if bb_range > 0 else 0.5,
        'adx_trending':      1 if (snap.get('adx', 20) or 20) > 25 else 0,
        'pressure_imbalance':buy_pres - 0.5,
        # 4-bucket session one-hot (replaces binary in_session)
        'session_asian':     row.get('_session_asian', 0),
        'session_london':    row.get('_session_london', 0),
        'session_nylon':     row.get('_session_nylon', 0),
        'session_ny':        row.get('_session_ny', 0),
        'confidence':        row.get('confidence', 50) or 50,
        'direction_buy':     1 if row.get('direction') == 'BUY' else 0,
    }


features = []
targets  = []
pairs_list = []
# Temporal ordering is essential for walk-forward validation. Every feature
# row is paired with its created_at so we can split on time, not at random.
created_list = []
# Phase 3 (item 11): regime tag per row for regime-specific models. Prefer the
# clean dataset's explicit `regime` column; fall back to the snapshot tag the
# signal route / worker persisted (indicator_snapshot._regime.marketRegime).
regimes_list = []

for _, row in df.iterrows():
    feat = extract_features(row)
    if feat is not None:
        features.append(feat)
        targets.append(1 if row['outcome'] == 'WIN' else 0)
        pairs_list.append(row.get('pair', 'EUR/USD'))
        created_list.append(row.get('created_at', ''))
        # Phase 3 (item 11): regime tag — prefer the clean dataset's explicit
        # column; fall back to the snapshot tag persisted by the signal route
        # (indicator_snapshot._regime.marketRegime).
        snap = row.get('indicator_snapshot', {})
        if isinstance(snap, dict):
            regime_tag = snap.get('_regime', {}).get('marketRegime', '') if isinstance(snap.get('_regime'), dict) else ''
        else:
            regime_tag = ''
        regimes_list.append(row.get('_regime', '') or regime_tag)

feature_df = pd.DataFrame(features)
y = np.array(targets)
created_col = pd.Series(created_list)

# One-hot encode pair using fixed set so serve.py always has the same columns
for p in ALL_PAIRS:
    col = f'pair_{p}'
    feature_df[col] = (pd.Series(pairs_list) == p).astype(int).values

# Drop hour_utc — too few samples to learn reliable time patterns;
# the model would overfit to the specific hours in our small dataset.
feature_df.drop(columns=[c for c in ['hour_utc'] if c in feature_df.columns], inplace=True)

# Drop rows with NaN — track the mask so created_col stays aligned with X/y
mask       = ~feature_df.isna().any(axis=1)
feature_df = feature_df[mask]
y          = y[mask.values]
created_col_filtered = created_col[mask.values].reset_index(drop=True)
# Phase 3 (item 11): keep the regime tag aligned with X/y through the NaN mask.
regimes_arr = np.array(regimes_list, dtype=object)[mask.values].tolist()

feature_names = list(feature_df.columns)
X = feature_df.values

n_wins  = int(y.sum())
n_loss  = int(len(y) - n_wins)
spw     = max(1.0, n_loss / n_wins) if n_wins > 0 else 1.0

print(f"✓ Features: {len(feature_names)} columns, {len(X)} samples")
print(f"  WIN: {n_wins}  LOSS: {n_loss}  win_rate={y.mean():.1%}  scale_pos_weight={spw:.1f}")

# ─── Walk-forward train/test split (audit Phase 1.2) ──────────────────────────
# Random train_test_split on time-series market data creates look-ahead bias:
# the model sees future price behaviour in training. Instead, sort strictly
# by created_at and walk the training window forward. The model is trained
# ONLY on past data and validated ONLY on future data it never saw.
#
# Protocol:
#   initial_train = 60% of samples (chronological)
#   fold_size     = 10% of samples (advances by 10% each step)
#   The FINAL reported AUC is the mean over all out-of-sample validation
#   folds — the honest estimate of live performance.

_ts_raw = created_col_filtered.map(
    lambda x: _parse_ts(str(x)) if isinstance(x, str) and x else None
)
_ts_dt  = pd.to_datetime(_ts_raw, errors='coerce', utc=True)

# Sort rows by created_at (stable for ties). Fall back to source order if NaT.
if _ts_dt.isna().all():
    order = np.arange(len(X))
    print("  ⚠  All timestamps missing — using source order (best-effort)")
else:
    order = np.argsort(_ts_dt.values, kind='stable')

X_sorted = X[order]
y_sorted = y[order]
n_total  = len(X_sorted)

AVG_AUC = 0.0

if n_total < 30:
    print(f"❌ Need at least 30 samples for walk-forward validation, got {n_total}")
    print("   Falling back to simple hold-out split (train=80%, val=20%).")
    cut      = int(n_total * 0.8)
    X_tr, X_va = X_sorted[:cut], X_sorted[cut:]
    y_tr, y_va = y_sorted[:cut], y_sorted[cut:]
    fold_spw = max(1.0, (len(y_tr) - y_tr.sum()) / max(1.0, y_tr.sum()))
    model = xgb.XGBClassifier(
        n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.7,
        colsample_bytree=0.7, min_child_weight=5, reg_alpha=0.1,
        reg_lambda=1.5, scale_pos_weight=fold_spw, eval_metric='aucpr',
        random_state=42,
    )
    model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    AVG_AUC = float(roc_auc_score(y_va, model.predict_proba(X_va)[:, 1]))
    print(f"  Holdout AUC = {AVG_AUC:.4f}")
    # Calibration set for the small-sample path = the holdout predictions.
    oob_proba = model.predict_proba(X_va)[:, 1].tolist()
    oob_y     = y_va.tolist()
else:
    train_frac = 0.60
    val_frac   = 0.10
    step_frac  = 0.10

    train_n = max(20, int(n_total * train_frac))
    val_n   = max(5,  int(n_total * val_frac))
    step_n  = max(5,  int(n_total * step_frac))

    fold_logs = []
    best_fold_model = None
    best_fold_auc   = -1.0
    # Phase 3 (item 10): accumulate every OOS (out-of-sample) prediction across
    # folds so we can fit a probability calibrator (Platt/isotonic) on data the
    # model never trained on — this is the honest calibration set.
    oob_proba: list = []
    oob_y: list     = []

    print(f"\n📊 Walk-forward split: {n_total} samples")
    print(f"   Initial train: {train_n} | Val step: {val_n} | Step size: {step_n}")

    cur_end = train_n
    fold_idx = 0
    while cur_end + val_n <= n_total:
        tr_end = cur_end
        va_end = cur_end + val_n
        if tr_end < 10 or va_end <= tr_end:
            break

        X_tr = X_sorted[:tr_end]
        y_tr = y_sorted[:tr_end]
        X_va = X_sorted[tr_end:va_end]
        y_va = y_sorted[tr_end:va_end]

        # Skip folds with a single class in validation (can't compute AUC)
        if len(np.unique(y_va)) < 2:
            print(f"  Fold {fold_idx}: skipped (val single-class)")
            cur_end += step_n
            fold_idx += 1
            continue

        fold_spw = max(1.0, (len(y_tr) - y_tr.sum()) / max(1.0, y_tr.sum()))

        fold_model = xgb.XGBClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.7,
            colsample_bytree=0.7, min_child_weight=5, reg_alpha=0.1,
            reg_lambda=1.5, scale_pos_weight=fold_spw, eval_metric='aucpr',
            random_state=42,
        )
        fold_model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)

        fold_auc = float(roc_auc_score(y_va, fold_model.predict_proba(X_va)[:, 1]))
        fold_acc = float(accuracy_score(y_va, fold_model.predict(X_va)))
        print(f"  Fold {fold_idx}: train={tr_end} val=[{tr_end}:{va_end}] "
              f"AUC={fold_auc:.4f} Acc={fold_acc:.4f}")
        fold_logs.append({'fold': fold_idx, 'auc': fold_auc, 'acc': fold_acc,
                          'train_end': tr_end, 'val_end': va_end})

        # Accumulate OOS predictions for later calibration fitting.
        oob_proba.extend(fold_model.predict_proba(X_va)[:, 1].tolist())
        oob_y.extend(y_va.tolist())

        if fold_auc > best_fold_auc:
            best_fold_auc = fold_auc
            best_fold_model = fold_model

        cur_end += step_n
        fold_idx += 1

    if not fold_logs:
        print("❌ No walk-forward folds — too few samples. Falling back.")
        cut = int(n_total * 0.8)
        X_tr, X_va = X_sorted[:cut], X_sorted[cut:]
        y_tr, y_va = y_sorted[:cut], y_sorted[cut:]
        fold_spw = max(1.0, (len(y_tr) - y_tr.sum()) / max(1.0, y_tr.sum()))
        best_fold_model = xgb.XGBClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.7,
            colsample_bytree=0.7, min_child_weight=5, reg_alpha=0.1,
            reg_lambda=1.5, scale_pos_weight=fold_spw, eval_metric='aucpr',
            random_state=42,
        )
        best_fold_model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
        best_fold_auc = float(roc_auc_score(y_va, best_fold_model.predict_proba(X_va)[:, 1]))
        fold_logs.append({'fold': 'holdout', 'auc': best_fold_auc})
        print(f"  Holdout AUC = {best_fold_auc:.4f}")

    AVG_AUC = float(np.mean([f['auc'] for f in fold_logs]))
    print("\n" + "=" * 60)
    print("📈 WALK-FORWARD VALIDATION (out-of-sample)")
    print("=" * 60)
    print(f"  Folds: {len(fold_logs)}")
    for f in fold_logs:
        print(f"    Fold {f['fold']}: AUC={f['auc']:.4f} "
              f"Acc={f.get('acc', float('nan')):.4f}")
    print(f"\n  Mean OOS AUC: {AVG_AUC:.4f}")

# ─── Phase 3, item 12: OOS AUC acceptance gate ────────────────────────────────
# The walk-forward OOS AUC is the honest estimate of live performance. If it is
# below the acceptance threshold, the model does not deserve to replace the
# production model — unless the operator explicitly forces it. This prevents a
# retrain regression from silently degrading live signals.
ACCEPTED = AVG_AUC >= args.min_oos_auc or args.force
if not ACCEPTED:
    print("\n" + "=" * 60)
    print("❌ ACCEPTANCE GATE FAILED (Phase 3, item 12)")
    print("=" * 60)
    print(f"  Walk-forward OOS AUC = {AVG_AUC:.4f}")
    print(f"  Minimum required      = {args.min_oos_auc:.4f}")
    print("  The model generalises no better than chance on out-of-sample data.")
    print("  Production model will NOT be overwritten.")
    if not args.force:
        print("  (Re-run with --force to override this gate.)")
        sys.exit(2)
else:
    print(f"\n✅ Acceptance gate passed: OOS AUC {AVG_AUC:.4f} ≥ {args.min_oos_auc:.4f}")

# ─── Phase 3, item 10: probability calibration ────────────────────────────────
# Fit a calibrator (Platt sigmoid or isotonic) on the OOS predictions — data the
# model never trained on. serve.py applies this so win_probability is a real
# calibrated probability, not a raw XGBoost score.
calibration = {'method': 'none', 'n': len(oob_y) if 'oob_y' in dir() else 0, 'auc': AVG_AUC}
if args.calibration != 'none' and 'oob_y' in dir() and len(oob_y) >= 50:
    oob_p = np.clip(np.array(oob_proba, dtype=float), 1e-6, 1 - 1e-6)
    oob_l = np.array(oob_y, dtype=int)
    try:
        if args.calibration == 'sigmoid':
            # Platt scaling: fit a logistic regressor on log-odds of the raw
            # probability. calibrated = sigmoid(a * logit(raw) + b).
            from sklearn.linear_model import LogisticRegression
            logit_p = np.log(oob_p / (1 - oob_p))
            lr = LogisticRegression()
            lr.fit(logit_p.reshape(-1, 1), oob_l)
            calibration = {
                'method': 'sigmoid',
                'a': float(lr.coef_[0][0]),
                'b': float(lr.intercept_[0]),
                'n': len(oob_l),
                'auc': AVG_AUC,
            }
        elif args.calibration == 'isotonic':
            from sklearn.isotonic import IsotonicRegression
            iso = IsotonicRegression(out_of_bounds='clip')
            iso.fit(oob_p, oob_l)
            calibration = {
                'method': 'isotonic',
                'xs': [float(x) for x in iso.X_thresholds_.tolist()],
                'ys': [float(y) for y in iso.y_thresholds_.tolist()],
                'y_min': float(iso.y_min_),
                'y_max': float(iso.y_max_),
                'n': len(oob_l),
                'auc': AVG_AUC,
            }
        print(f"✓ Calibration fit: {calibration['method']} on {len(oob_l)} OOS samples")
    except Exception as e:
        print(f"⚠ Calibration failed ({e}) — serving raw probabilities")
        calibration = {'method': 'none', 'n': len(oob_l), 'auc': AVG_AUC}
else:
    print("  ℹ  No calibration (method=none, or <50 OOS samples)")

# ─── Train final model on ALL data for deployment ─────────────────────────────

print("\n\n🧠 Training final model on all data (for deployment)...")

# Final model uses the same hyperparameters. We train on all samples without
# a separate holdout (the walk-forward AUC above is our honest OOS metric).
model = xgb.XGBClassifier(
    n_estimators=150,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.7,
    colsample_bytree=0.7,
    min_child_weight=5,
    reg_alpha=0.1,
    reg_lambda=1.5,
    scale_pos_weight=spw,
    eval_metric='aucpr',
    random_state=42,
)
model.fit(X, y, verbose=False)

# ─── In-sample evaluation (informational only) ────────────────────────────────

y_pred  = model.predict(X)
y_proba = model.predict_proba(X)[:, 1]

in_auc = float(roc_auc_score(y, y_proba))
print("\n" + "=" * 60)
print("📈 MODEL PERFORMANCE")
print("=" * 60)
print(f"\nIn-sample Accuracy:  {accuracy_score(y, y_pred):.4f}")
print(f"In-sample ROC-AUC:   {in_auc:.4f}")
print(f"Walk-forward OOS AUC: {AVG_AUC:.4f}   ← use this for validation")
print(f"\n{classification_report(y, y_pred, target_names=['LOSS', 'WIN'])}")

importance = model.feature_importances_
sorted_idx = np.argsort(importance)[::-1]
print("\n🏆 Top 10 Feature Importance:")
for i in range(min(10, len(feature_names))):
    idx = sorted_idx[i]
    print(f"  {i+1}. {feature_names[idx]:.<35} {importance[idx]:.4f}")

# ─── Save ─────────────────────────────────────────────────────────────────────

model_path    = os.path.join(MODEL_DIR, 'scalper_model.json')
features_path = os.path.join(MODEL_DIR, 'features.json')
calib_path    = os.path.join(MODEL_DIR, 'calibration.json')
metrics_path  = os.path.join(MODEL_DIR, 'metrics.json')

# Always write calibration + metrics (serve.py reads both to report model
# provenance). The model itself is only overwritten when the acceptance gate
# passes (Phase 3, item 12) — a failed retrain must not silently replace the
# live model with a worse one.
model.save_model(model_path)
with open(features_path, 'w') as f:
    json.dump(feature_names, f)
with open(calib_path, 'w') as f:
    json.dump(calibration, f)

metrics = {
    'walk_forward_auc':  round(AVG_AUC, 4),
    'in_sample_auc':     round(in_auc, 4),
    'folds':             [{'fold': f['fold'], 'auc': round(f['auc'], 4),
                           'acc': round(f.get('acc', 0), 4)} for f in fold_logs] if 'fold_logs' in dir() else [],
    'n_samples':         int(len(X)),
    'n_wins':            int(n_wins),
    'n_loss':            int(n_loss),
    'acceptance': {
        'gate':         args.min_oos_auc,
        'passed':       bool(ACCEPTED),
        'forced':       bool(args.force),
        'model_saved':  bool(ACCEPTED),
    },
    'calibration':       calibration,
    'trained_at':        pd.Timestamp.utcnow().isoformat(),
}
with open(metrics_path, 'w') as f:
    json.dump(metrics, f, indent=2)

if ACCEPTED:
    print(f"\n✓ Model saved    → {model_path}")
    print(f"✓ Features saved → {features_path}")
    print(f"✓ Calibration    → {calib_path}")
    print(f"✓ Metrics        → {metrics_path}")
else:
    # Acceptance gate failed and not forced — remove the model file we just
    # wrote so serve.py keeps serving the previous production model.
    if os.path.exists(model_path):
        os.remove(model_path)
    print(f"\n✗ Production model NOT saved (acceptance gate failed). Existing model preserved.")
    print(f"✓ Calibration + metrics still written → {calib_path}, {metrics_path}")
    sys.exit(2)

# ─── Phase 3, item 11: regime-specific models ────────────────────────────────
# Train one XGBoost model per market regime (when enough labelled samples exist)
# so live inference can pick the model tuned for the current regime. The signal
# route already classifies the regime per signal; serve.py routes /predict by
# the `regime` field. Regimes with too few samples fall back to the global model.
regime_models_saved: list = []
if any(regimes_arr):
    regime_names = ['chop', 'ranging', 'weak-trend', 'trending', 'strong-trend']
    for regime in regime_names:
        idx = [i for i, r in enumerate(regimes_arr) if r == regime]
        if len(idx) < args.min_regime_samples:
            if idx:
                print(f"  ℹ  Regime '{regime}': only {len(idx)} samples (< {args.min_regime_samples}) — using global model")
            continue
        Xr = X[np.array(idx)]
        yr = y[np.array(idx)]
        rw = int(yr.sum())
        rl = int(len(yr) - rw)
        r_spw = max(1.0, rl / rw) if rw > 0 else 1.0
        r_model = xgb.XGBClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.7,
            colsample_bytree=0.7, min_child_weight=5, reg_alpha=0.1,
            reg_lambda=1.5, scale_pos_weight=r_spw, eval_metric='aucpr',
            random_state=42,
        )
        r_model.fit(Xr, yr, verbose=False)
        r_path = os.path.join(MODEL_DIR, f'scalper_model_{regime}.json')
        r_model.save_model(r_path)
        # Same feature set — no separate features file needed, but record it.
        regime_models_saved.append(regime)
        print(f"  ✓ Regime model '{regime}': {len(idx)} samples (WIN {rw}/LOSS {rl}) → {r_path}")

    # Persist the list of available regime models for serve.py + metrics.
    metrics['regime_models'] = regime_models_saved
    with open(metrics_path, 'w') as f:
        json.dump(metrics, f, indent=2)
    if regime_models_saved:
        print(f"  ✓ Regime-specific models saved: {', '.join(regime_models_saved)}")
    else:
        print("  ℹ  No regime-specific models (insufficient labelled samples per regime)")

print(f"\n🚀 Ready to serve! Run: python ml/serve.py")
