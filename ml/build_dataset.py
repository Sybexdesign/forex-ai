#!/usr/bin/env python3
"""
ml/build_dataset.py — Phase 3 (item 9): build a clean labeled dataset for training.

Why this exists (audit finding #11): the old synthetic path (generate_signals.py)
applied the *identical* rule engine and labeled its own output, so the ML could
never outperform the rule it was trained to replicate. This script instead:

  1. Pulls REAL resolved signals (outcome WIN/LOSS) from Supabase.
  2. Drops rows that are gated/contaminated: HOLD directions, missing SL/TP,
     simulated feeds, and signals demoted by a gate (gating_reasons non-empty)
     where the predicted direction disagreed with the executed one.
  3. Attaches the market regime per row (from indicator_snapshot._regime, else
     classified from ADX) so train.py can build regime-specific models.

Output: ml/data/clean_dataset.csv — consumed by `python train.py --dataset ...`

Usage:
    cd forex-ai/ml
    python build_dataset.py [--out data/clean_dataset.csv] [--min-confidence 0]
"""

import os
import sys
import json
import argparse
import csv

from supabase import create_client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
load_dotenv()

SUPABASE_URL = os.environ['NEXT_PUBLIC_SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']


# Regime classification — mirrors app/api/scalper/signal/route.ts classifyRegime.
def regime_from_adx(adx: float) -> str:
    if adx < 15: return 'chop'
    if adx < 20: return 'ranging'
    if adx < 25: return 'weak-trend'
    if adx < 28: return 'trending'
    return 'strong-trend'


def main():
    parser = argparse.ArgumentParser(description='Build clean labeled dataset')
    parser.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'data', 'clean_dataset.csv'),
                        help='Output CSV path')
    parser.add_argument('--min-confidence', type=float, default=0,
                        help='Drop signals below this confidence (0-100)')
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # ── 1. Fetch resolved signals ─────────────────────────────────────────────
    all_rows = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            sb.table('signals')
              .select('id, pair, direction, confidence, outcome, created_at, '
                      'predicted_direction, gating_reasons, indicator_snapshot')
              .in_('outcome', ['WIN', 'LOSS'])
              .order('created_at', desc=True)
              .range(offset, offset + page_size - 1)
              .execute()
        )
        rows = resp.data
        if not rows:
            break
        all_rows.extend(rows)
        offset += page_size
    print(f"✓ Fetched {len(all_rows)} resolved signals")


    # ── 2. Re-label + filter ──────────────────────────────────────────────────
    cleaned = []
    dropped_hold = dropped_sim = dropped_nosl = dropped_gated = dropped_lowconf = 0

    for r in all_rows:
        direction = (r.get('direction') or 'HOLD').upper()
        if direction not in ('BUY', 'SELL'):
            dropped_hold += 1
            continue

        snap = r.get('indicator_snapshot')
        if not snap or not isinstance(snap, dict):
            continue

        # Skip simulated feeds — a fake price sequence produces fake labels.
        if snap.get('simulated'):
            dropped_sim += 1
            continue

        confidence = float(r.get('confidence') or 0)
        if confidence < args.min_confidence:
            dropped_lowconf += 1
            continue

        # Reconstruct SL/TP from the stored snapshot (signal route persists
        # _computed.entry/sl/tp for browser inserts; worker inserts carry the
        # raw tick with price + atr). Canonical formula matches
        # label/route.ts reconstructSlTp and workers/scalper.mjs:
        #   sl = price ∓ atr*1.5, tp = price ± atr*2.5
        computed = snap.get('_computed') if isinstance(snap.get('_computed'), dict) else {}
        price = computed.get('entry') or snap.get('price') or snap.get('currentPrice')
        atr   = snap.get('atr') or 0
        sl    = computed.get('sl')
        tp    = computed.get('tp')
        if not sl or not tp:
            if not price or not atr:
                dropped_nosl += 1
                continue
            sl = (price - atr * 1.5) if direction == 'BUY' else (price + atr * 1.5)
            tp = (price + atr * 2.5) if direction == 'BUY' else (price - atr * 2.5)
        if not sl or not tp or abs(sl - tp) < 1e-12:
            dropped_nosl += 1
            continue

        # Gating hygiene: if a gate changed the direction (gating_reasons non-
        # empty) and the predicted direction differs from the executed one, the
        # row is a "gated" signal — its outcome label does not reflect the raw
        # prediction we are trying to learn, so drop it.
        gating = r.get('gating_reasons') or []
        pred   = (r.get('predicted_direction') or '').upper()
        if gating and pred in ('BUY', 'SELL') and pred != direction:
            dropped_gated += 1
            continue

        # Regime: prefer the persisted regime tag; fall back to ADX classification.
        regime = ''
        if isinstance(snap.get('_regime'), dict):
            regime = snap['_regime'].get('marketRegime', '') or ''
        if not regime:
            regime = regime_from_adx(float(snap.get('adx') or 20))

        cleaned.append({
            'pair':                r.get('pair', 'XAU/USD'),
            'direction':           direction,
            'confidence':          int(confidence),
            'outcome':             r['outcome'],
            'created_at':          r.get('created_at', ''),
            'regime':              regime,
            'gating_reasons':      json.dumps(gating),
            'indicator_snapshot':  json.dumps(snap),
        })

    print(f"  Re-labelled set: {len(cleaned)} rows")
    print(f"  Dropped: HOLD={dropped_hold} simulated={dropped_sim} no-SL/TP={dropped_nosl} "
          f"gated-flip={dropped_gated} low-confidence={dropped_lowconf}")

    if not cleaned:
        print("✗ No clean rows — nothing to write.")
        sys.exit(1)

    # ── 3. Write CSV ──────────────────────────────────────────────────────────
    with open(args.out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'pair', 'direction', 'confidence', 'outcome', 'created_at',
            'regime', 'gating_reasons', 'indicator_snapshot',
        ])
        writer.writeheader()
        writer.writerows(cleaned)

    wins = sum(1 for c in cleaned if c['outcome'] == 'WIN')
    losses = len(cleaned) - wins
    print(f"\n✓ Clean dataset written → {args.out}")
    print(f"  WIN: {wins}  LOSS: {losses}  win_rate={wins/len(cleaned):.1%}")
    print(f"\n  Next: python train.py --dataset {args.out} --calibration sigmoid")


if __name__ == '__main__':
    main()
