#!/usr/bin/env python3
"""ml/serve.py — FastAPI prediction service for XGBoost scalper model"""

import os
import json
import subprocess
import sys
import threading
import time
import numpy as np
import xgboost as xgb
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

MODEL_DIR   = os.path.join(os.path.dirname(__file__), 'model')
STATUS_PATH = os.path.join(MODEL_DIR, 'worker_status.json')
DATA_DIR    = os.path.join(os.path.dirname(__file__), 'data')

PIP_VALUES = {
    'EUR/USD': 0.0001, 'GBP/USD': 0.0001, 'AUD/USD': 0.0001,
    'USD/CAD': 0.0001, 'USD/CHF': 0.0001, 'NZD/USD': 0.0001,
    'USD/JPY': 0.01,   'GBP/JPY': 0.01,   'EUR/JPY': 0.01,
    'XAU/USD': 0.1,    'XAG/USD': 0.01,
}

ALL_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD',
             'USD/CHF', 'NZD/USD', 'XAU/USD', 'XAG/USD']

# Load model at startup — fail fast if model files are missing
model_path    = os.path.join(MODEL_DIR, 'scalper_model.json')
features_path = os.path.join(MODEL_DIR, 'features.json')

if not os.path.exists(model_path):
    raise FileNotFoundError(f"Model not found at {model_path}. Run: python ml/train.py")

model = xgb.XGBClassifier()
model.load_model(model_path)

with open(features_path) as f:
    FEATURE_NAMES = json.load(f)

print(f"✓ Scalper model loaded: {len(FEATURE_NAMES)} features")

# 1-hour cache for /predict_daily_auto results keyed by metal ('gold'|'silver')
_auto_cache: dict = {}  # {'gold': {'result': {...}, 'ts': float}, ...}
_AUTO_CACHE_TTL = 3600  # seconds

# Background retrain state
_retrain_lock   = threading.Lock()
_retrain_thread: Optional[threading.Thread] = None

# Load daily model — optional, graceful degradation if not yet trained
daily_model_path    = os.path.join(MODEL_DIR, 'daily_model.json')
daily_features_path = os.path.join(MODEL_DIR, 'daily_features.json')

daily_model: Optional[xgb.XGBClassifier] = None
DAILY_FEATURE_NAMES: list = []

if os.path.exists(daily_model_path) and os.path.exists(daily_features_path):
    daily_model = xgb.XGBClassifier()
    daily_model.load_model(daily_model_path)
    with open(daily_features_path) as f:
        DAILY_FEATURE_NAMES = json.load(f)
    print(f"✓ Daily model loaded: {len(DAILY_FEATURE_NAMES)} features")
else:
    print("ℹ  Daily model not found — run: python ml/train_daily.py")

app = FastAPI(title="ForexAI Scalper ML", version="1.0")


# ─── Request / Response schemas ───────────────────────────────────────────────

class PredictRequest(BaseModel):
    pair:               str
    direction:          str
    confidence:         float
    indicators:         dict
    scalperIndicators:  dict
    timestamp:          Optional[str] = None


class PredictResponse(BaseModel):
    win_probability:      float
    should_trade:         bool
    ml_confidence:        int
    feature_contributions: dict


class DailyPredictRequest(BaseModel):
    pair:     str            # 'XAU/USD' or 'XAG/USD'
    features: dict           # pre-computed 28 daily features from market_data.py


class DailyPredictResponse(BaseModel):
    up_probability:        float
    direction:             str   # 'UP' or 'DOWN'
    confidence:            int
    feature_contributions: dict


# ─── Feature extraction — must be IDENTICAL to train.py ──────────────────────

def extract_features(req: PredictRequest) -> dict:
    ind     = req.indicators
    scal    = req.scalperIndicators
    pip_val = PIP_VALUES.get(req.pair, 0.0001)
    price   = ind.get('currentPrice', 0) or ind.get('price', 0)
    bb_upper= ind.get('bbUpper', 0)
    bb_lower= ind.get('bbLower', 0)
    bb_range= bb_upper - bb_lower if bb_upper > bb_lower else 1
    atr     = scal.get('atr', ind.get('atr', 0.0005)) or 0.0005
    rsi     = ind.get('rsi', ind.get('rsi14', 50)) or 50
    ema9    = scal.get('ema9',  ind.get('ema9',  price)) or price
    ema21   = scal.get('ema21', ind.get('ema21', price)) or price

    hour = datetime.utcnow().hour
    if req.timestamp:
        try:
            hour = datetime.fromisoformat(req.timestamp.replace('Z', '+00:00')).hour
        except Exception:
            pass

    features = {
        'rsi':             rsi,
        'rsi7':            scal.get('rsi7',  ind.get('rsi7',  50)) or 50,
        'macd_histogram':  ind.get('macdHistogram', 0) or 0,
        'macd_line':       ind.get('macdLine',      0) or 0,
        'macd_signal':     ind.get('macdSignal',    0) or 0,
        'adx':             ind.get('adx', 20) or 20,
        'bb_width':        ind.get('bbWidth', 0.002) or 0.002,
        'ema20':           ind.get('ema20', price) or price,
        'ema50':           ind.get('ema50', price) or price,
        'ema9':            ema9,
        'ema21':           ema21,
        'buy_pressure':    scal.get('buyPressure', ind.get('buyPressure', 0.5)) or 0.5,
        'tick_volume':     scal.get('tickVolume',  ind.get('tickVolume',  0))   or 0,
        'atr':             atr,
        'rsi_zone':           1 if rsi < 30 else (-1 if rsi > 70 else 0),
        'macd_positive':      1 if (ind.get('macdHistogram', 0) or 0) > 0 else 0,
        'ema_bullish':        1 if ema9 > ema21 else 0,
        'bb_position':        (price - bb_lower) / bb_range if bb_range > 0 else 0.5,
        'atr_pips':           atr / pip_val if pip_val > 0 else 0,
        'adx_trending':       1 if (ind.get('adx', 20) or 20) > 25 else 0,
        'pressure_imbalance': (scal.get('buyPressure', ind.get('buyPressure', 0.5)) or 0.5) - 0.5,
        'hour_utc':           hour,
        'price_vs_ema50':     (price - (ind.get('ema50', price) or price)) / price if price > 0 else 0,
        'price_vs_ema20':     (price - (ind.get('ema20', price) or price)) / price if price > 0 else 0,
        'confidence':         req.confidence or 50,
        'direction_buy':      1 if req.direction == 'BUY' else 0,
        'in_session':         1 if (hour < 5 or hour >= 19) else 0,
    }

    # One-hot pair encoding — same fixed set as train.py
    for p in ALL_PAIRS:
        features[f'pair_{p}'] = 1 if req.pair == p else 0

    return features


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post('/predict', response_model=PredictResponse)
def predict(req: PredictRequest):
    try:
        features = extract_features(req)
        X        = np.array([[features.get(f, 0) for f in FEATURE_NAMES]])
        proba    = model.predict_proba(X)[0]
        win_prob = float(proba[1])

        # Top 5 feature contributions
        importances = model.feature_importances_
        sorted_idx  = np.argsort(importances)[::-1][:5]
        top_feats   = {
            FEATURE_NAMES[i]: {
                'importance': round(float(importances[i]), 4),
                'value':      round(float(features.get(FEATURE_NAMES[i], 0)), 4),
            }
            for i in sorted_idx
        }

        return PredictResponse(
            win_probability=round(win_prob, 4),
            should_trade=win_prob >= 0.55,
            ml_confidence=int(win_prob * 100),
            feature_contributions=top_feats,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/predict_daily', response_model=DailyPredictResponse)
def predict_daily(req: DailyPredictRequest):
    if daily_model is None:
        raise HTTPException(status_code=503, detail="Daily model not loaded. Run: python ml/train_daily.py")
    try:
        X      = np.array([[req.features.get(f, 0) for f in DAILY_FEATURE_NAMES]])
        proba  = daily_model.predict_proba(X)[0]
        up_prob = float(proba[1])

        importances = daily_model.feature_importances_
        sorted_idx  = np.argsort(importances)[::-1][:5]
        top_feats   = {
            DAILY_FEATURE_NAMES[i]: {
                'importance': round(float(importances[i]), 4),
                'value':      round(float(req.features.get(DAILY_FEATURE_NAMES[i], 0)), 4),
            }
            for i in sorted_idx
        }

        return DailyPredictResponse(
            up_probability=round(up_prob, 4),
            direction='UP' if up_prob >= 0.5 else 'DOWN',
            confidence=int(up_prob * 100),
            feature_contributions=top_feats,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/health')
def health():
    return {
        'status':        'ok',
        'scalper_model': {'features': len(FEATURE_NAMES)},
        'daily_model':   {'features': len(DAILY_FEATURE_NAMES), 'loaded': daily_model is not None},
    }


# ─── Worker endpoints ─────────────────────────────────────────────────────────

@app.get('/worker/status')
def worker_status():
    if not os.path.exists(STATUS_PATH):
        return {'worker_status': 'never_run'}
    with open(STATUS_PATH) as f:
        return json.load(f)


@app.post('/worker/retrain')
def worker_retrain():
    global _retrain_thread
    with _retrain_lock:
        if _retrain_thread and _retrain_thread.is_alive():
            return {'status': 'already_running'}

        worker_script = os.path.join(os.path.dirname(__file__), 'worker_daily.py')

        def _run():
            try:
                subprocess.run(
                    [sys.executable, worker_script],
                    cwd=os.path.dirname(__file__),
                    timeout=600,
                )
                # Reload daily model after worker finishes
                if os.path.exists(daily_model_path) and os.path.exists(daily_features_path):
                    global daily_model, DAILY_FEATURE_NAMES, _auto_cache
                    _m = xgb.XGBClassifier()
                    _m.load_model(daily_model_path)
                    with open(daily_features_path) as fh:
                        _fn = json.load(fh)
                    daily_model         = _m
                    DAILY_FEATURE_NAMES = _fn
                    _auto_cache         = {}   # invalidate auto cache
                    print("✓ Daily model reloaded after worker run")
            except Exception as e:
                print(f"✗ worker_daily retrain error: {e}")

        _retrain_thread = threading.Thread(target=_run, daemon=True)
        _retrain_thread.start()
    return {'status': 'started'}


@app.get('/predict_daily_auto')
def predict_daily_auto(pair: str = Query(..., description="XAU/USD or XAG/USD")):
    if daily_model is None:
        raise HTTPException(status_code=503, detail="Daily model not loaded. Run: python ml/train_daily.py")

    metal = 'gold' if 'XAU' in pair.upper() else 'silver' if 'XAG' in pair.upper() else None
    if metal is None:
        raise HTTPException(status_code=400, detail="pair must be XAU/USD or XAG/USD")

    # Return cached result if still fresh
    cached = _auto_cache.get(metal)
    if cached and (time.time() - cached['ts']) < _AUTO_CACHE_TTL:
        return {**cached['result'], 'cached': True}

    # Load CSVs — both required for gs_ratio computation
    gold_csv   = os.path.join(DATA_DIR, 'gold_raw.csv')
    silver_csv = os.path.join(DATA_DIR, 'silver_raw.csv')
    if not os.path.exists(gold_csv) or not os.path.exists(silver_csv):
        raise HTTPException(status_code=503, detail="Market data CSVs not found. Run: python worker_daily.py")

    try:
        import pandas as pd
        from market_data import _clean, _engineer

        def _load(path):
            df = pd.read_csv(path, index_col='Date', parse_dates=True)
            df.index = pd.to_datetime(df.index).tz_localize(None)
            return df

        gold_raw   = _load(gold_csv)
        silver_raw = _load(silver_csv)

        gold_clean   = _clean(gold_raw,   'gold')
        silver_clean = _clean(silver_raw, 'silver')
        gold_feat, silver_feat = _engineer(gold_clean, silver_clean)

        gold_feat['is_silver']   = 0
        silver_feat['is_silver'] = 1

        feat_df = gold_feat if metal == 'gold' else silver_feat

        # Use the last fully-populated row
        feat_df = feat_df.dropna()
        if feat_df.empty:
            raise HTTPException(status_code=503, detail="No complete feature rows available")

        last_row  = feat_df.iloc[-1]
        feat_dict = last_row.to_dict()
        X         = np.array([[feat_dict.get(f, 0.0) for f in DAILY_FEATURE_NAMES]])

        proba   = daily_model.predict_proba(X)[0]
        up_prob = float(proba[1])

        importances = daily_model.feature_importances_
        sorted_idx  = np.argsort(importances)[::-1][:5]
        top_feats   = {
            DAILY_FEATURE_NAMES[i]: {
                'importance': round(float(importances[i]), 4),
                'value':      round(float(feat_dict.get(DAILY_FEATURE_NAMES[i], 0)), 4),
            }
            for i in sorted_idx
        }

        result = {
            'pair':                 pair,
            'metal':                metal,
            'up_probability':       round(up_prob, 4),
            'direction':            'UP' if up_prob >= 0.5 else 'DOWN',
            'confidence':           int(up_prob * 100),
            'feature_date':         str(last_row.name.date()),
            'feature_contributions': top_feats,
            'cached':               False,
        }

        _auto_cache[metal] = {'result': result, 'ts': time.time()}
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', os.environ.get('ML_PORT', '8100')))
    print(f"🚀 ML service starting on port {port}")
    uvicorn.run(app, host='0.0.0.0', port=port)
