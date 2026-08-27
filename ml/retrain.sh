#!/usr/bin/env bash
# ml/retrain.sh — Weekly XGBoost retraining
# Add to crontab: 0 2 * * 0 /path/to/forex-ai/ml/retrain.sh >> /var/log/forex-ml-retrain.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV="$SCRIPT_DIR/.venv"
LOG_PREFIX="[retrain $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX Starting weekly retrain..."

# Activate virtualenv if present, otherwise rely on system python
if [ -f "$VENV/bin/activate" ]; then
  source "$VENV/bin/activate"
fi

# Load env vars from project root .env.local
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  source "$PROJECT_DIR/.env.local"
  set +a
fi

cd "$SCRIPT_DIR"

# Phase 3 (item 9): build the clean labeled dataset first — consistent
# SL/TP-first-hit re-labeling of real resolved signals.
echo "$LOG_PREFIX Building clean dataset..."
python build_dataset.py

# Phase 3 (items 10-12): train with Platt calibration, regime-specific models,
# and the OOS-AUC acceptance gate. If the gate fails, train.py exits non-zero
# and the existing production model is preserved (no silent regression).
python train.py --dataset "$SCRIPT_DIR/data/clean_dataset.csv" --calibration sigmoid

echo "$LOG_PREFIX Retrain complete. Reloading serve.py via PM2..."
pm2 reload forex-ml --update-env 2>/dev/null || echo "$LOG_PREFIX PM2 reload skipped (not running under PM2)"

echo "$LOG_PREFIX Done."
