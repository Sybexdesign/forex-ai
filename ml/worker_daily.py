#!/usr/bin/env python3
"""
ml/worker_daily.py — Daily data accumulation, retraining, and model versioning.

Pulls latest gold/silver candles, appends to CSV dataset, re-engineers
all features, trains a new model, and only replaces the live model if
the new one performs equal or better on the holdout test set.

Usage:
    python worker_daily.py           # normal run (compare + conditionally replace)
    python worker_daily.py --force   # always replace model regardless of metrics
"""

import os
import sys
import json
import argparse
import shutil
import numpy as np
import xgboost as xgb
import pandas as pd
from typing import Optional, Tuple
from datetime import datetime, timezone
from sklearn.metrics import roc_auc_score, accuracy_score
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

from market_data import (
    _merge, _clean, _engineer, _save_cache, _load_cache,
    START_DATE, TRAIN_RATIO, DATA_DIR,
)

MODEL_DIR    = os.path.join(os.path.dirname(__file__), 'model')
VERSIONS_DIR = os.path.join(MODEL_DIR, 'versions')
STATUS_PATH  = os.path.join(MODEL_DIR, 'worker_status.json')
LIVE_MODEL   = os.path.join(MODEL_DIR, 'daily_model.json')
LIVE_FEATS   = os.path.join(MODEL_DIR, 'daily_features.json')
MAX_VERSIONS = 10

_EXCLUDE = frozenset(['Open', 'High', 'Low', 'Close', 'Volume', 'target'])

os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(VERSIONS_DIR, exist_ok=True)


# ─── Status helpers ───────────────────────────────────────────────────────────

def write_status(status: dict) -> None:
    with open(STATUS_PATH, 'w') as f:
        json.dump(status, f, indent=2, default=str)


def read_status() -> dict:
    if not os.path.exists(STATUS_PATH):
        return {'worker_status': 'never_run'}
    with open(STATUS_PATH) as f:
        return json.load(f)


# ─── Versioning ───────────────────────────────────────────────────────────────

def _next_version() -> int:
    files = [f for f in os.listdir(VERSIONS_DIR) if f.startswith('daily_model_v')]
    nums = []
    for f in files:
        try:
            nums.append(int(f.split('_v')[1].split('_')[0]))
        except (IndexError, ValueError):
            pass
    return (max(nums) + 1) if nums else 1


def _prune_versions() -> None:
    files = sorted(
        [f for f in os.listdir(VERSIONS_DIR) if f.startswith('daily_model_v')],
        key=lambda f: os.path.getmtime(os.path.join(VERSIONS_DIR, f)),
    )
    for old in files[:-MAX_VERSIONS]:
        os.remove(os.path.join(VERSIONS_DIR, old))
        print(f"  Pruned: {old}")


# ─── Latest data pull (period=10d, not full history) ─────────────────────────

def _pull_latest() -> dict:
    """Pull last 10 days from yfinance to pick up the most recent candles."""
    try:
        import yfinance as yf
    except ImportError:
        print("  ✗  yfinance not installed")
        return {'gold': pd.DataFrame(), 'silver': pd.DataFrame()}

    import time

    ALL_SYMS = ['GC=F', 'SI=F', 'GLD', 'SLV']
    SYM_META = {
        'GC=F': ('gold',   'futures'), 'SI=F': ('silver', 'futures'),
        'GLD':  ('gold',   'etf'),     'SLV':  ('silver', 'etf'),
    }

    print("  yfinance ▸ period=10d")
    raw = None
    for attempt in range(1, 4):
        raw = yf.download(tickers=ALL_SYMS, period='10d', progress=False,
                          auto_adjust=True, group_by='ticker')
        if raw is not None and not raw.empty:
            break
        if attempt < 3:
            print(f"    ⚠  Rate-limited — waiting 20s (attempt {attempt}/3)")
            time.sleep(20)

    result: dict = {'gold': pd.DataFrame(), 'silver': pd.DataFrame()}
    if raw is None or raw.empty:
        print("    ✗  yfinance failed — no new candles pulled")
        return result

    buckets: dict = {'gold': {}, 'silver': {}}
    for sym in ALL_SYMS:
        metal, kind = SYM_META[sym]
        try:
            df = raw[sym][['Open', 'High', 'Low', 'Close', 'Volume']].copy()
            df = df.dropna(how='all')
            if df.empty:
                continue
            df.index = pd.to_datetime(df.index).tz_localize(None)
            df.index.name = 'Date'
            df.columns.name = None
            buckets[metal][kind] = df
        except Exception as e:
            print(f"    ⚠  {sym}: {e}")

    for metal in ('gold', 'silver'):
        futures = buckets[metal].get('futures')
        etf     = buckets[metal].get('etf')
        result[metal] = futures if futures is not None else (etf if etf is not None else pd.DataFrame())

    return result


# ─── Cache helpers ────────────────────────────────────────────────────────────

def _load_existing(metal: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, f'{metal}_raw.csv')
    if os.path.exists(path):
        return _load_cache(metal)
    return pd.DataFrame()


def _append(existing: pd.DataFrame, new: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
    if new.empty:
        return existing, 0
    if existing.empty:
        return new.copy(), len(new)
    new_only = new[~new.index.isin(existing.index)]
    if new_only.empty:
        return existing, 0
    merged = pd.concat([existing, new_only]).sort_index()
    merged = merged[~merged.index.duplicated(keep='first')]
    return merged, len(new_only)


# ─── Feature + split builder ──────────────────────────────────────────────────

def _build_xy(gold: pd.DataFrame, silver: pd.DataFrame) -> tuple:
    gold_clean   = _clean(gold,   'gold')
    silver_clean = _clean(silver, 'silver')
    g_feat, s_feat = _engineer(gold_clean, silver_clean)
    g_feat['is_silver']   = 0
    s_feat['is_silver'] = 1
    combined = pd.concat([g_feat, s_feat]).sort_index()
    combined.dropna(inplace=True)
    feature_cols = [c for c in combined.columns if c not in _EXCLUDE]
    X = combined[feature_cols].values.astype(float)
    y = combined['target'].values.astype(int)
    cut     = int(len(X) * TRAIN_RATIO)
    X_train = X[:cut];  X_test  = X[cut:]
    y_train = y[:cut];  y_test  = y[cut:]
    return X_train, X_test, y_train, y_test, feature_cols


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(force: bool = False) -> None:
    start_time = datetime.now(timezone.utc)
    write_status({'worker_status': 'running', 'started_at': start_time.isoformat()})

    print("\n" + "═" * 60)
    print("  ForexAI Daily Worker — Data Pull + Retrain")
    print("═" * 60 + "\n")

    # 1. Pull latest candles
    print("📥  Pulling latest candles...")
    latest = _pull_latest()

    # 2. Load existing cache and append
    print("\n📂  Updating dataset...")
    gold_existing   = _load_existing('gold')
    silver_existing = _load_existing('silver')

    gold_merged,   gold_added   = _append(gold_existing,   latest['gold'])
    silver_merged, silver_added = _append(silver_existing, latest['silver'])

    print(f"  Gold:   {len(gold_existing):,} → {len(gold_merged):,} rows  (+{gold_added})")
    print(f"  Silver: {len(silver_existing):,} → {len(silver_merged):,} rows  (+{silver_added})")

    if gold_added > 0:
        _save_cache('gold', gold_merged)
        print("  ✓  gold_raw.csv updated")
    if silver_added > 0:
        _save_cache('silver', silver_merged)
        print("  ✓  silver_raw.csv updated")

    dataset_size   = len(gold_merged) + len(silver_merged)
    data_freshness = str(gold_merged.index[-1].date()) if not gold_merged.empty else 'unknown'

    # 3. Re-engineer features
    print("\n🔧  Re-engineering features on full dataset...")
    X_train, X_test, y_train, y_test, feature_names = _build_xy(gold_merged, silver_merged)
    print(f"  Train: {len(X_train):,} | Test: {len(X_test):,} | Features: {len(feature_names)}")

    # 4. Score existing model as baseline
    old_auc = 0.0
    old_acc = 0.0
    if os.path.exists(LIVE_MODEL) and not force:
        try:
            old_model = xgb.XGBClassifier()
            old_model.load_model(LIVE_MODEL)
            old_proba = old_model.predict_proba(X_test)[:, 1]
            old_auc   = float(roc_auc_score(y_test, old_proba))
            old_acc   = float(accuracy_score(y_test, old_model.predict(X_test)))
            print(f"\n  Existing model  →  AUC={old_auc:.4f}  Acc={old_acc:.4f}")
        except Exception as e:
            print(f"  ⚠  Could not score existing model: {e}")
    else:
        print("\n  No baseline model — training fresh")

    # 5. Train new model (same hyperparams as train_daily.py)
    n_wins = int(y_train.sum())
    n_loss = int(len(y_train) - n_wins)
    spw    = max(1.0, n_loss / n_wins) if n_wins > 0 else 1.0

    print(f"\n🧠  Training  (UP={n_wins} DOWN={n_loss} spw={spw:.2f})...")
    new_model = xgb.XGBClassifier(
        n_estimators=300, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=2,
        scale_pos_weight=spw, eval_metric='aucpr', random_state=42,
    )
    new_model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

    new_proba = new_model.predict_proba(X_test)[:, 1]
    new_auc   = float(roc_auc_score(y_test, new_proba))
    new_acc   = float(accuracy_score(y_test, new_model.predict(X_test)))
    print(f"  New model       →  AUC={new_auc:.4f}  Acc={new_acc:.4f}")

    # 6. Compare — only replace if new model is at least as good
    should_replace = force or (new_auc >= old_auc)

    version = _next_version()
    if should_replace:
        date_str = datetime.now().strftime('%Y%m%d')
        ver_path = os.path.join(VERSIONS_DIR, f'daily_model_v{version}_{date_str}.json')
        if os.path.exists(LIVE_MODEL):
            shutil.copy2(LIVE_MODEL, ver_path)
            print(f"\n  ✓  Archived v{version} → {os.path.basename(ver_path)}")
        new_model.save_model(LIVE_MODEL)
        with open(LIVE_FEATS, 'w') as f:
            json.dump(feature_names, f)
        _prune_versions()
        print(f"  ✓  Live model replaced  (AUC {old_auc:.4f} → {new_auc:.4f})")
        action = 'replaced'
    else:
        print(f"\n  ⚠  New AUC {new_auc:.4f} < {old_auc:.4f} — keeping existing model")
        action = 'kept_existing'

    # 7. Write status
    imp         = new_model.feature_importances_
    top_feats   = [feature_names[i] for i in np.argsort(imp)[::-1][:10]]
    elapsed     = (datetime.now(timezone.utc) - start_time).total_seconds()
    live_auc    = new_auc if should_replace else old_auc
    live_acc    = new_acc if should_replace else old_acc

    status = {
        'worker_status':  'idle',
        'last_trained':   datetime.now(timezone.utc).isoformat(),
        'dataset_size':   dataset_size,
        'model_accuracy': round(live_acc, 4),
        'model_auc':      round(live_auc, 4),
        'data_freshness': data_freshness,
        'model_version':  version,
        'top_features':   top_feats,
        'rows_added':     gold_added + silver_added,
        'action':         action,
        'elapsed_s':      round(elapsed, 1),
    }
    write_status(status)

    print(f"\n{'═' * 60}")
    print(f"  Done in {elapsed:.1f}s  |  dataset={dataset_size}  |  AUC={live_auc:.4f}  |  {action}")
    print(f"{'═' * 60}\n")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Daily data worker + model retraining')
    parser.add_argument('--force', action='store_true', help='Always replace model regardless of metrics')
    args = parser.parse_args()
    main(force=args.force)
