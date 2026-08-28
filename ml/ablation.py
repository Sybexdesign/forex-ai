#!/usr/bin/env python3
"""
ml/ablation.py — Phase 5 (item 15): Ablation harness on rolling windows.

Measures which feature groups actually contribute to out-of-sample performance.
For every feature group (oscillators, MACD, EMA/Bollinger, sessions, pair,
confidence/direction, spread), we retrain the SAME walk-forward protocol used by
train.py on a rolling window and record the mean OOS AUC with that group
REMOVED. Comparing "full model" vs "without group X" shows whether X helps
(+delta), hurts (−delta), or is noise (~0).

Usage:
    python ablation.py                                        # uses clean_dataset.csv
    python ablation.py --dataset data/clean_dataset.csv --min-regime-samples 0
    python ablation.py --features  # also print per-feature (not just group) deltas

Output: ml/data/ablation_report.json + console table.
"""

import os
import sys
import json
import argparse
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score, accuracy_score
from supabase import create_client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

parser = argparse.ArgumentParser(description='Ablation harness (Phase 5, item 15)')
parser.add_argument('--dataset', default=os.path.join(os.path.dirname(__file__), 'data', 'clean_dataset.csv'),
                    help='Path to clean_dataset.csv (from build_dataset.py)')
parser.add_argument('--min-regime-samples', type=int, default=500,
                    help='Minimum samples per regime to include it in the report')
parser.add_argument('--features', action='store_true',
                    help='Also run per-feature (not just per-group) ablation')
parser.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'data', 'ablation_report.json'))
args = parser.parse_args()

PIP_VALUES = {
    'EUR/USD': 0.0001, 'GBP/USD': 0.0001, 'AUD/USD': 0.0001,
    'USD/CAD': 0.0001, 'USD/CHF': 0.0001, 'NZD/USD': 0.0001,
    'USD/JPY': 0.01,   'GBP/JPY': 0.01,   'EUR/JPY': 0.01,
    'XAU/USD': 0.1,    'XAG/USD': 0.01,
}
ALL_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD',
             'USD/CHF', 'NZD/USD', 'XAU/USD', 'XAG/USD']

# Feature groups — must match the feature names produced by extract_features.
FEATURE_GROUPS = {
    'oscillators':   ['rsi', 'rsi7', 'adx', 'buy_pressure', 'rsi_zone', 'adx_trending'],
    'macd':          ['macd_hist_atr', 'macd_line_atr', 'macd_signal_atr', 'macd_positive'],
    'ema_bb':        ['ema9_vs_ema21', 'price_vs_ema20', 'price_vs_ema50',
                      'ema_bullish', 'bb_width_rel', 'bb_position'],
    'sessions':      ['session_asian', 'session_london', 'session_nylon', 'session_ny'],
    'pair':          [f'pair_{p}' for p in ALL_PAIRS],
    'confidence':    ['confidence', 'direction_buy'],
    'pressure':      ['pressure_imbalance'],
}
ALL_GROUP_FEATURES = sorted({f for feats in FEATURE_GROUPS.values() for f in feats})


def extract_features(row):
    snap = row.get('indicator_snapshot', {})
    if not snap or not isinstance(snap, dict):
        return None
    scalper  = snap.get('scalper', {})
    pair     = row.get('pair', 'EUR/USD')
    price    = snap.get('currentPrice', 0) or snap.get('price', 0)
    bb_upper = snap.get('bbUpper', 0)
    bb_lower = snap.get('bbLower', 0)
    bb_range = bb_upper - bb_lower if bb_upper > bb_lower else 1
    atr      = scalper.get('atr', snap.get('atr', 0.0005)) or 0.0005
    rsi      = snap.get('rsi', snap.get('rsi14', 50)) or 50
    ema9     = scalper.get('ema9',  snap.get('ema9',  price)) or price
    ema21    = scalper.get('ema21', snap.get('ema21', price)) or price
    ema20    = snap.get('ema20', price) or price
    ema50    = snap.get('ema50', price) or price
    macd_hist = snap.get('macdHistogram', 0) or 0
    buy_pres  = scalper.get('buyPressure', snap.get('buyPressure', 0.5)) or 0.5
    hour = 12
    try:
        from datetime import datetime, timezone
        hour = datetime.fromisoformat(str(row['created_at']).replace('Z', '+00:00')).hour
    except Exception:
        pass

    return {
        'rsi':               rsi,
        'rsi7':              scalper.get('rsi7', snap.get('rsi7', 50)) or 50,
        'adx':               snap.get('adx', 20) or 20,
        'buy_pressure':      buy_pres,
        'macd_hist_atr':     macd_hist / atr if atr > 0 else 0,
        'macd_line_atr':     (snap.get('macdLine', 0) or 0) / atr if atr > 0 else 0,
        'macd_signal_atr':   (snap.get('macdSignal', 0) or 0) / atr if atr > 0 else 0,
        'bb_width_rel':      (snap.get('bbWidth', 0.002) or 0.002) / price if price > 0 else 0,
        'ema9_vs_ema21':     (ema9 - ema21) / atr if atr > 0 else 0,
        'price_vs_ema20':    (price - ema20) / atr if atr > 0 else 0,
        'price_vs_ema50':    (price - ema50) / atr if atr > 0 else 0,
        'rsi_zone':          1 if rsi < 30 else (-1 if rsi > 70 else 0),
        'macd_positive':     1 if macd_hist > 0 else 0,
        'ema_bullish':       1 if ema9 > ema21 else 0,
        'bb_position':       (price - bb_lower) / bb_range if bb_range > 0 else 0.5,
        'adx_trending':      1 if (snap.get('adx', 20) or 20) > 25 else 0,
        'pressure_imbalance':buy_pres - 0.5,
        'session_asian':     1 if (hour >= 22 or hour < 7)  else 0,
        'session_london':    1 if (7  <= hour < 13)          else 0,
        'session_nylon':     1 if (13 <= hour < 17)          else 0,
        'session_ny':        1 if (17 <= hour < 22)          else 0,
        'confidence':        row.get('confidence', 50) or 50,
        'direction_buy':     1 if row.get('direction') == 'BUY' else 0,
    }


def load_dataset(path):
    ds = pd.read_csv(path)
    rows = []
    for _, r in ds.iterrows():
        snap = r.get('indicator_snapshot', '{}')
        if isinstance(snap, str):
            try:
                snap = json.loads(snap)
            except Exception:
                snap = {}
        rows.append({
            'indicator_snapshot': snap,
            'direction':          r.get('direction', 'HOLD'),
            'confidence':         int(r.get('confidence', 50)),
            'outcome':            r.get('outcome', 'LOSS'),
            'pair':               r.get('pair', 'XAU/USD'),
            'created_at':         r.get('created_at', '2026-01-01T00:00:00+00:00'),
            '_regime':            r.get('regime', ''),
        })
    return rows


def build_matrix(rows, feature_subset=None):
    features, targets, created = [], [], []
    for row in rows:
        feat = extract_features(row)
        if feat is None:
            continue
        # pair one-hot always included (not part of ablation subsets)
        for p in ALL_PAIRS:
            feat[f'pair_{p}'] = 1 if row['pair'] == p else 0
        if feature_subset is not None:
            feat = {k: v for k, v in feat.items() if k in feature_subset}
        features.append(feat)
        targets.append(1 if row['outcome'] == 'WIN' else 0)
        created.append(row.get('created_at', ''))
    df = pd.DataFrame(features)
    mask = ~df.isna().any(axis=1)
    df = df[mask]
    y = np.array(targets)[mask.values]
    c = pd.Series(created)[mask.values]
    return df.values, y, c, list(df.columns)


def _parse_ts(ts):
    import re
    from datetime import datetime, timezone
    ts = re.sub(r'\.\d+', '', str(ts))
    ts = re.sub(r'[+-]\d{2}:\d{2}$', '', ts).replace('Z', '').strip()
    try:
        return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except Exception:
        return None


def walk_forward_auc(X, y, created):
    """Mean OOS AUC using the same chronological walk-forward protocol as train.py."""
    n = len(X)
    if n < 60:
        return None
    order = np.argsort(pd.to_datetime(created.map(_parse_ts), errors='coerce', utc=True).values, kind='stable')
    Xs, ys = X[order], y[order]
    train_n = max(20, int(n * 0.6))
    val_n   = max(5,  int(n * 0.1))
    step_n  = max(5,  int(n * 0.1))
    aucs = []
    cur = train_n
    while cur + val_n <= n:
        tr, va = cur, cur + val_n
        X_tr, y_tr = Xs[:tr], ys[:tr]
        X_va, y_va = Xs[tr:va], ys[tr:va]
        if len(np.unique(y_va)) < 2:
            cur += step_n
            continue
        spw = max(1.0, (len(y_tr) - y_tr.sum()) / max(1.0, y_tr.sum()))
        m = xgb.XGBClassifier(n_estimators=150, max_depth=3, learning_rate=0.05,
                              subsample=0.7, colsample_bytree=0.7, min_child_weight=5,
                              reg_alpha=0.1, reg_lambda=1.5, scale_pos_weight=spw,
                              eval_metric='aucpr', random_state=42)
        m.fit(X_tr, y_tr, verbose=False)
        aucs.append(float(roc_auc_score(y_va, m.predict_proba(X_va)[:, 1])))
        cur += step_n
    return float(np.mean(aucs)) if aucs else None


def main():
    if not os.path.exists(args.dataset):
        print(f"✗ Dataset not found: {args.dataset}")
        print("  Run: python build_dataset.py")
        sys.exit(1)

    rows = load_dataset(args.dataset)
    print(f"✓ Loaded {len(rows)} rows from {args.dataset}")

    # ── Full-feature baseline ────────────────────────────────────────────────
    X, y, created, full_cols = build_matrix(rows)
    baseline_auc = walk_forward_auc(X, y, created)
    print(f"\nFull-feature walk-forward OOS AUC: {baseline_auc:.4f}\n")

    report = {
        'baseline_auc': baseline_auc,
        'n_samples': int(len(X)),
        'n_features': len(full_cols),
        'groups': {},
    }

    # ── Group ablation: remove each group, keep everything else ──────────────
    for group, feats in FEATURE_GROUPS.items():
        keep = [f for f in full_cols if f not in set(feats)]
        Xg, yg, cg, _ = build_matrix(rows, feature_subset=keep)
        auc = walk_forward_auc(Xg, yg, cg)
        if auc is None:
            print(f"  {group:12s} — insufficient samples")
            continue
        delta = round(auc - baseline_auc, 4)
        verdict = ('HELPS' if delta > 0.005 else 'HURTS' if delta < -0.005 else 'noise')
        print(f"  {group:12s} removed → AUC {auc:.4f}  (Δ {delta:+.4f})  {verdict}")
        report['groups'][group] = {'auc_without': round(auc, 4), 'delta': delta, 'verdict': verdict}

    # ── Optional per-feature ablation ────────────────────────────────────────
    if args.features:
        report['features'] = {}
        for feat in full_cols:
            if feat.startswith('pair_'):
                continue
            keep = [f for f in full_cols if f != feat]
            Xf, yf, cf, _ = build_matrix(rows, feature_subset=keep)
            auc = walk_forward_auc(Xf, yf, cf)
            if auc is None:
                continue
            delta = round(auc - baseline_auc, 4)
            report['features'][feat] = {'auc_without': round(auc, 4), 'delta': delta}
        for feat, d in sorted(report['features'].items(), key=lambda kv: kv[1]['delta']):
            print(f"    {feat:24s} Δ {d['delta']:+.4f}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\n✓ Ablation report → {args.out}")


if __name__ == '__main__':
    main()
