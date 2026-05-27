#!/usr/bin/env python3
"""ml/train.py — Train XGBoost on Supabase signal data"""

import os
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score, accuracy_score
from supabase import create_client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

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

print("📡 Fetching signals from Supabase...")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

all_rows = []
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

print(f"✓ Total rows with WIN/LOSS outcome: {len(all_rows)}")

# Train on all historical WIN/LOSS data — the scan route's pre-filters (session
# gate, ADX floor, RSI gate) already stop bad signals reaching the model at
# inference time. Training on the full dataset gives the model enough samples
# to learn what WIN vs LOSS looks like across all conditions.
from datetime import datetime, timezone

def add_session_feature(row: dict) -> dict:
    """Add hour_utc and is_session_active features derived from created_at."""
    try:
        dt   = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        hour = dt.astimezone(timezone.utc).hour
        row['_hour']   = hour
        row['_in_session'] = 1 if (hour < 5 or hour >= 19) else 0  # active = 19-04 UTC
    except Exception:
        row['_hour']   = 12
        row['_in_session'] = 0
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

    rsi  = snap.get('rsi', snap.get('rsi14', 50)) or 50
    ema9 = scalper.get('ema9',  snap.get('ema9',  price)) or price
    ema21= scalper.get('ema21', snap.get('ema21', price)) or price

    return {
        # Core indicators
        'rsi':             rsi,
        'rsi7':            scalper.get('rsi7',  snap.get('rsi7',  50)) or 50,
        'macd_histogram':  snap.get('macdHistogram', 0) or 0,
        'macd_line':       snap.get('macdLine',      0) or 0,
        'macd_signal':     snap.get('macdSignal',    0) or 0,
        'adx':             snap.get('adx', 20) or 20,
        'bb_width':        snap.get('bbWidth', 0.002) or 0.002,
        'ema20':           snap.get('ema20', price) or price,
        'ema50':           snap.get('ema50', price) or price,
        # Scalper sub-object
        'ema9':            ema9,
        'ema21':           ema21,
        'buy_pressure':    scalper.get('buyPressure', snap.get('buyPressure', 0.5)) or 0.5,
        'tick_volume':     scalper.get('tickVolume',  snap.get('tickVolume',  0))   or 0,
        'atr':             atr,
        # Engineered
        'rsi_zone':           1 if rsi < 30 else (-1 if rsi > 70 else 0),
        'macd_positive':      1 if (snap.get('macdHistogram', 0) or 0) > 0 else 0,
        'ema_bullish':        1 if ema9 > ema21 else 0,
        'bb_position':        (price - bb_lower) / bb_range if bb_range > 0 else 0.5,
        'atr_pips':           atr / pip_val if pip_val > 0 else 0,
        'adx_trending':       1 if (snap.get('adx', 20) or 20) > 25 else 0,
        'pressure_imbalance': (scalper.get('buyPressure', snap.get('buyPressure', 0.5)) or 0.5) - 0.5,
        'hour_utc':           hour,
        'price_vs_ema50':     (price - (snap.get('ema50', price) or price)) / price if price > 0 else 0,
        'price_vs_ema20':     (price - (snap.get('ema20', price) or price)) / price if price > 0 else 0,
        'confidence':         row.get('confidence', 50) or 50,
        'direction_buy':      1 if row.get('direction') == 'BUY' else 0,
        'in_session':         row.get('_in_session', 0),
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
    n_estimators=300,
    max_depth=4,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=2,
    scale_pos_weight=spw,   # compensates for WIN/LOSS imbalance
    eval_metric='aucpr',    # area under precision-recall — better for imbalanced data
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
