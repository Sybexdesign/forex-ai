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
python train.py

echo "$LOG_PREFIX Retrain complete. Reloading serve.py via PM2..."
pm2 reload forex-ml --update-env 2>/dev/null || echo "$LOG_PREFIX PM2 reload skipped (not running under PM2)"

echo "$LOG_PREFIX Done."
