#!/usr/bin/env python3
"""ml/serve.py — FastAPI prediction service for XGBoost scalper model"""

import os
import json
import numpy as np
import xgboost as xgb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'model')

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

print(f"✓ Model loaded: {len(FEATURE_NAMES)} features")

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


@app.get('/health')
def health():
    return {
        'status':   'ok',
        'model':    'xgboost',
        'features': len(FEATURE_NAMES),
    }


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', os.environ.get('ML_PORT', '8100')))
    print(f"🚀 ML service starting on port {port}")
    uvicorn.run(app, host='0.0.0.0', port=port)
