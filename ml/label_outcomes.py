#!/usr/bin/env python3
"""
ml/label_outcomes.py — Retroactively label PENDING signals as WIN or LOSS.

Uses the M5 candle cache the MT5 EA pushes to broker_configs.config.candleCache
to determine whether TP or SL was hit first after each signal.

Usage:
  cd forex-ai/ml
  source .venv/bin/activate
  python label_outcomes.py
"""

import os
import sys
import time
from datetime import datetime, timezone
from supabase import create_client
from dotenv import load_dotenv

load_dotenv('../.env.local')
load_dotenv()

SUPABASE_URL = os.environ['NEXT_PUBLIC_SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Map from pair notation to EA symbol (no slash)
PAIR_TO_SYMBOL = {
    'XAU/USD': 'XAUUSD', 'XAG/USD': 'XAGUSD',
    'EUR/USD': 'EURUSD', 'GBP/USD': 'GBPUSD',
    'USD/JPY': 'USDJPY', 'AUD/USD': 'AUDUSD',
    'USD/CAD': 'USDCAD', 'USD/CHF': 'USDCHF',
    'NZD/USD': 'NZDUSD', 'GBP/JPY': 'GBPJPY',
}

PIP_VALUES = {
    'EUR/USD': 0.0001, 'GBP/USD': 0.0001, 'AUD/USD': 0.0001,
    'USD/CAD': 0.0001, 'USD/CHF': 0.0001, 'NZD/USD': 0.0001,
    'USD/JPY': 0.01,   'GBP/JPY': 0.01,
    'XAU/USD': 0.1,    'XAG/USD': 0.01,
}


def load_candle_cache() -> dict:
    """
    Fetch candle caches from all broker_configs rows.
    Returns { 'XAUUSD': [(epoch, high, low), ...], ... } sorted by time ascending.
    """
    print('📦 Loading candle cache from broker_configs...')
    resp = sb.table('broker_configs').select('config').execute()
    combined: dict[str, list] = {}

    for row in resp.data:
        cfg = row.get('config') or {}
        cache = cfg.get('candleCache') or {}
        for key, val in cache.items():
            # key format: "XAUUSD_M5"
            symbol = key.split('_')[0]
            candles_raw = val.get('candles') or []
            for c in candles_raw:
                # c = {"t": epoch, "o": ..., "h": ..., "l": ..., "c": ..., "v": ...}
                try:
                    entry = (int(c['t']), float(c['h']), float(c['l']))
                    combined.setdefault(symbol, []).append(entry)
                except (KeyError, TypeError, ValueError):
                    continue

    # Sort each symbol's candles by time and deduplicate
    for sym in combined:
        seen = set()
        deduped = []
        for c in sorted(combined[sym], key=lambda x: x[0]):
            if c[0] not in seen:
                seen.add(c[0])
                deduped.append(c)
        combined[sym] = deduped

    summary = {k: len(v) for k, v in combined.items()}
    print(f'  Candles loaded: {summary}')
    return combined


def determine_outcome(direction: str, sl: float, tp: float,
                      candles: list, after_epoch: int):
    """
    Walk candles that start after after_epoch.
    Return 'WIN', 'LOSS', or None if unresolved.
    """
    for (t, high, low) in candles:
        if t <= after_epoch:
            continue
        if direction == 'BUY':
            if low  <= sl: return 'LOSS'
            if high >= tp: return 'WIN'
        else:
            if high >= sl: return 'LOSS'
            if low  <= tp: return 'WIN'
    return None


def main():
    candle_cache = load_candle_cache()

    if not candle_cache:
        print('\n❌ No candle data found in broker_configs.')
        print('   Make sure the MT5 EA is running and has synced at least once.')
        sys.exit(1)

    print('\n📡 Fetching PENDING signals from Supabase...')
    all_signals = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            sb.table('signals')
              .select('id, pair, direction, created_at, indicator_snapshot')
              .eq('outcome', 'PENDING')
              .order('created_at', desc=False)
              .range(offset, offset + page_size - 1)
              .execute()
        )
        batch = resp.data
        if not batch:
            break
        all_signals.extend(batch)
        offset += page_size

    print(f'Found {len(all_signals)} PENDING signals\n')
    if not all_signals:
        print('Nothing to label.')
        return

    labeled = 0
    skipped = 0
    unresolved = 0

    for sig in all_signals:
        sig_id    = sig['id']
        pair      = sig['pair']
        direction = sig['direction']
        snap      = sig.get('indicator_snapshot') or {}
        created   = sig['created_at']

        prefix = f'  [{pair} {direction} @ {created[:16]}]'

        if direction not in ('BUY', 'SELL'):
            print(f'{prefix} skipped — direction {direction!r}')
            skipped += 1
            continue

        symbol = PAIR_TO_SYMBOL.get(pair)
        if not symbol or symbol not in candle_cache:
            print(f'{prefix} skipped — no candles for {pair} (symbol={symbol})')
            skipped += 1
            continue

        # Get price and ATR from snapshot
        price = (snap.get('price') or snap.get('currentPrice') or 0)
        atr   = snap.get('atr') or 0
        if not atr:
            pip   = PIP_VALUES.get(pair, 0.0001)
            atr   = (snap.get('atrPips') or 1) * pip

        if not price or not atr:
            print(f'{prefix} skipped — no price ({price}) or ATR ({atr})')
            skipped += 1
            continue

        sl = (price - atr * 1.5) if direction == 'BUY' else (price + atr * 1.5)
        tp = (price + atr * 2.5) if direction == 'BUY' else (price - atr * 2.5)

        try:
            dt = datetime.fromisoformat(created.replace('Z', '+00:00'))
            after_epoch = int(dt.timestamp())
        except ValueError:
            print(f'{prefix} skipped — bad timestamp')
            skipped += 1
            continue

        outcome = determine_outcome(direction, sl, tp, candle_cache[symbol], after_epoch)

        if outcome is None:
            print(f'{prefix} unresolved — candle window exhausted without hitting TP/SL')
            unresolved += 1
            continue

        try:
            sb.table('signals').update({'outcome': outcome}).eq('id', sig_id).execute()
            print(f'{prefix} → {outcome} ✓')
            labeled += 1
        except Exception as e:
            print(f'{prefix} update failed: {e}')
            skipped += 1

        time.sleep(0.05)

    print(f'\n{"="*52}')
    print(f'Labeled:    {labeled}')
    print(f'Unresolved: {unresolved}  (candles didn\'t cover full trade)')
    print(f'Skipped:    {skipped}  (missing data / no candles)')
    print(f'{"="*52}')

    if labeled > 0:
        print(f'\nRun  python train.py  once you have ≥ 100 WIN/LOSS labels.')


if __name__ == '__main__':
    main()
