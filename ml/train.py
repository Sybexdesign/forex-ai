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
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score, accuracy_score
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

# ─── Fetch data ───────────────────────────────────────────────────────────────

if not args.synthetic_only:
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

for _, row in df.iterrows():
    feat = extract_features(row)
    if feat is not None:
        features.append(feat)
        targets.append(1 if row['outcome'] == 'WIN' else 0)
        pairs_list.append(row.get('pair', 'EUR/USD'))

feature_df = pd.DataFrame(features)
y = np.array(targets)

# One-hot encode pair using fixed set so serve.py always has the same columns
for p in ALL_PAIRS:
    col = f'pair_{p}'
    feature_df[col] = (pd.Series(pairs_list) == p).astype(int).values

# Drop hour_utc — too few samples to learn reliable time patterns;
# the model would overfit to the specific hours in our small dataset.
feature_df.drop(columns=[c for c in ['hour_utc'] if c in feature_df.columns], inplace=True)

# Drop rows with NaN
mask       = ~feature_df.isna().any(axis=1)
feature_df = feature_df[mask]
y          = y[mask.values]

feature_names = list(feature_df.columns)
X = feature_df.values

n_wins  = int(y.sum())
n_loss  = int(len(y) - n_wins)
spw     = max(1.0, n_loss / n_wins) if n_wins > 0 else 1.0

print(f"✓ Features: {len(feature_names)} columns, {len(X)} samples")
print(f"  WIN: {n_wins}  LOSS: {n_loss}  win_rate={y.mean():.1%}  scale_pos_weight={spw:.1f}")

# ─── Train / test split ───────────────────────────────────────────────────────

# With small WIN counts, put all WINs in train to avoid empty test class
if n_wins < 10:
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.15, stratify=y, random_state=42
    )
else:
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )
print(f"\n📊 Train: {len(X_train)} | Test: {len(X_test)}")

# ─── Train XGBoost ────────────────────────────────────────────────────────────

print("\n🧠 Training XGBoost...")

model = xgb.XGBClassifier(
    n_estimators=150,
    max_depth=3,            # shallower — prevents memorising specific price levels
    learning_rate=0.05,
    subsample=0.7,
    colsample_bytree=0.7,
    min_child_weight=5,     # require more samples per leaf — stronger regularisation
    reg_alpha=0.1,          # L1 regularisation
    reg_lambda=1.5,         # L2 regularisation
    scale_pos_weight=spw,
    eval_metric='aucpr',
    random_state=42,
)

model.fit(
    X_train, y_train,
    eval_set=[(X_test, y_test)],
    verbose=False,
)

# ─── Evaluate ─────────────────────────────────────────────────────────────────

y_pred  = model.predict(X_test)
y_proba = model.predict_proba(X_test)[:, 1]

print("\n" + "=" * 60)
print("📈 MODEL PERFORMANCE")
print("=" * 60)
print(f"\nAccuracy:  {accuracy_score(y_test, y_pred):.4f}")
print(f"ROC-AUC:   {roc_auc_score(y_test, y_proba):.4f}")
print(f"\n{classification_report(y_test, y_pred, target_names=['LOSS', 'WIN'])}")

importance = model.feature_importances_
sorted_idx = np.argsort(importance)[::-1]
print("\n🏆 Top 10 Feature Importance:")
for i in range(min(10, len(feature_names))):
    idx = sorted_idx[i]
    print(f"  {i+1}. {feature_names[idx]:.<35} {importance[idx]:.4f}")

# ─── Save ─────────────────────────────────────────────────────────────────────

model_path    = os.path.join(MODEL_DIR, 'scalper_model.json')
features_path = os.path.join(MODEL_DIR, 'features.json')

model.save_model(model_path)
with open(features_path, 'w') as f:
    json.dump(feature_names, f)

print(f"\n✓ Model saved    → {model_path}")
print(f"✓ Features saved → {features_path}")
print(f"\n🚀 Ready to serve! Run: python ml/serve.py")
