#!/usr/bin/env python3
"""
ml/train_daily.py — Train XGBoost on 26 years of gold/silver daily OHLCV data.

Uses market_data.py to pull and engineer features, then trains a separate
daily direction model (UP/DOWN next-day close) that coexists with the
existing scalper signal model.

Usage:
    cd forex-ai/ml
    source .venv/bin/activate
    python train_daily.py
"""

import os
import json
import numpy as np
import xgboost as xgb
from sklearn.metrics import classification_report, roc_auc_score, accuracy_score
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

from market_data import build_splits

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'model')
os.makedirs(MODEL_DIR, exist_ok=True)

av_key = os.environ.get('ALPHA_VANTAGE_KEY') or None

# ─── Data ────────────────────────────────────────────────────────────────────

X_train, X_test, y_train, y_test, feature_names = build_splits(av_key=av_key)

n_wins = int(y_train.sum())
n_loss = int(len(y_train) - n_wins)
spw    = max(1.0, n_loss / n_wins) if n_wins > 0 else 1.0

print(f"\n📊 Train: {len(X_train)} | Test: {len(X_test)}")
print(f"  UP: {n_wins}  DOWN: {n_loss}  win_rate={y_train.mean():.1%}  scale_pos_weight={spw:.2f}")

# ─── Train ───────────────────────────────────────────────────────────────────

print("\n🧠 Training XGBoost daily model...")

model = xgb.XGBClassifier(
    n_estimators=300,
    max_depth=4,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=2,
    scale_pos_weight=spw,
    eval_metric='aucpr',
    random_state=42,
)

model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

# ─── Evaluate ────────────────────────────────────────────────────────────────

y_pred  = model.predict(X_test)
y_proba = model.predict_proba(X_test)[:, 1]

print("\n" + "=" * 60)
print("📈 DAILY MODEL PERFORMANCE")
print("=" * 60)
print(f"\nAccuracy:  {accuracy_score(y_test, y_pred):.4f}")
print(f"ROC-AUC:   {roc_auc_score(y_test, y_proba):.4f}")
print(f"\n{classification_report(y_test, y_pred, target_names=['DOWN', 'UP'])}")

importance = model.feature_importances_
sorted_idx = np.argsort(importance)[::-1]
print("🏆 Top 10 Feature Importance:")
for i in range(min(10, len(feature_names))):
    idx = sorted_idx[i]
    print(f"  {i+1}. {feature_names[idx]:.<35} {importance[idx]:.4f}")

# ─── Save ────────────────────────────────────────────────────────────────────

model_path    = os.path.join(MODEL_DIR, 'daily_model.json')
features_path = os.path.join(MODEL_DIR, 'daily_features.json')

model.save_model(model_path)
with open(features_path, 'w') as f:
    json.dump(feature_names, f)

print(f"\n✓ Model saved    → {model_path}")
print(f"✓ Features saved → {features_path}")
print(f"\n🚀 Daily model ready. Endpoint: POST /predict_daily")
