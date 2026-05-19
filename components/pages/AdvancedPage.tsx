'use client'
// components/pages/AdvancedPage.tsx
// Full advanced technical analysis:
// 1. Fibonacci Retracements
// 2. ATR Dynamic TP/SL
// 3. Candlestick Pattern Detection
// 4. Support & Resistance Auto-Detection

import { useState, useEffect } from 'react'
import { Panel, LoadingDots, StatCard, CopyValue } from '../ui'
import { authFetch } from '@/lib/api'

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'EUR/GBP', 'GBP/JPY', 'USD/CHF', 'NZD/USD', 'EUR/JPY', 'XAU/USD', 'XAG/USD']
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1H', '4H', 'Daily']

const SIGNAL_COLOR: Record<string, string> = {
  BULLISH: '#00ff87', BEARISH: '#ff3056', NEUTRAL: '#ffb800',
  STRONGLY_BULLISH: '#00ff87', STRONGLY_BEARISH: '#ff3056',
}

const STRENGTH_COLOR: Record<string, string> = {
  STRONG: '#00ff87', MODERATE: '#ffb800', WEAK: '#607080'
}

const VOLATILITY_COLOR: Record<string, string> = {
  HIGH: '#ff3056', MEDIUM: '#ffb800', LOW: '#00ff87'
}

// ─── Mini components ─────────────────────────────────────────────────────────

function SectionHeader({ title, badge, badgeColor = '#60c0ff' }: { title: string; badge?: string; badgeColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 1.5 }}>{title}</span>
      {badge && (
        <span style={{
          fontSize: 11, fontWeight: 700, color: badgeColor,
          background: `${badgeColor}15`, border: `1px solid ${badgeColor}35`,
          padding: '2px 10px', borderRadius: 2,
        }}>{badge}</span>
      )}
    </div>
  )
}

function StrengthDots({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} style={{
          width: 8, height: 8, borderRadius: '50%',
          background: i < value ? '#0080ff' : 'var(--border)',
          boxShadow: i < value ? '0 0 4px rgba(0,128,255,0.5)' : 'none',
        }} />
      ))}
    </div>
  )
}

// ─── FIBONACCI PANEL ─────────────────────────────────────────────────────────

function FibPanel({ fib, currentPrice }: { fib: any; currentPrice: number }) {
  if (!fib) return null
  const range = fib.swing_high - fib.swing_low

  return (
    <Panel title="FIBONACCI RETRACEMENTS">
      <div style={{ padding: '12px 16px' }}>
        {/* Swing info */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, padding: '8px 10px', background: 'rgba(255,48,86,0.06)', borderRadius: 3, border: '1px solid rgba(255,48,86,0.15)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>SWING HIGH</div>
            <div className="mono" style={{ fontSize: 15, color: '#ff6060', fontWeight: 700 }}>
              {fib.swing_high.toFixed(5)}
            </div>
          </div>
          <div style={{ flex: 1, padding: '8px 10px', background: 'rgba(0,255,135,0.06)', borderRadius: 3, border: '1px solid rgba(0,255,135,0.15)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>SWING LOW</div>
            <div className="mono" style={{ fontSize: 15, color: '#00ff87', fontWeight: 700 }}>
              {fib.swing_low.toFixed(5)}
            </div>
          </div>
          <div style={{ flex: 1, padding: '8px 10px', background: 'rgba(0,128,255,0.06)', borderRadius: 3, border: '1px solid rgba(0,128,255,0.15)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>TREND</div>
            <div style={{ fontSize: 13, color: fib.trend === 'BULLISH' ? '#00ff87' : '#ff3056', fontWeight: 700 }}>
              {fib.trend === 'BULLISH' ? '▲ BULLISH' : '▼ BEARISH'}
            </div>
          </div>
        </div>

        {/* Visual fib levels */}
        <div style={{ position: 'relative', marginBottom: 14 }}>
          {fib.levels.map((level: any, i: number) => {
            const pct = ((level.price - fib.swing_low) / (range || 1)) * 100
            const isKey = [0.382, 0.5, 0.618].includes(level.ratio)
            const isCurrent = Math.abs(level.price - currentPrice) < range * 0.03
            const isExtension = level.ratio > 1
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 0',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: isCurrent ? 'rgba(255,184,0,0.06)' : 'transparent',
              }}>
                {/* Fib color bar */}
                <div style={{ width: 3, height: 20, borderRadius: 2, flexShrink: 0,
                  background: isExtension ? '#607080' : isKey ? '#FFD700' : '#0080ff',
                  opacity: isKey ? 1 : 0.6,
                }} />
                <span className="mono" style={{
                  fontSize: 12, width: 44, flexShrink: 0,
                  color: isKey ? '#FFD700' : isExtension ? '#405060' : '#60c0ff',
                  fontWeight: isKey ? 700 : 400,
                }}>{level.label}</span>
                <span className="mono" style={{
                  fontSize: 13, flex: 1,
                  color: isCurrent ? '#ffb800' : 'var(--text-secondary)',
                  fontWeight: isCurrent ? 700 : 400,
                }}>{level.price.toFixed(5)}</span>
                <span style={{
                  fontSize: 10, color: level.type === 'support' ? '#00c060' : level.type === 'resistance' ? '#ff6060' : '#405060',
                  background: level.type === 'support' ? 'rgba(0,192,96,0.1)' : level.type === 'resistance' ? 'rgba(255,96,96,0.1)' : 'rgba(255,255,255,0.05)',
                  padding: '1px 6px', borderRadius: 2, flexShrink: 0,
                }}>{level.type.toUpperCase()}</span>
                {isCurrent && <span style={{ fontSize: 10, color: '#ffb800' }}>← NOW</span>}
              </div>
            )
          })}
        </div>

        {/* Visual bar */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>PRICE POSITION ON FIB RANGE</div>
          <div style={{ position: 'relative', height: 16, background: 'linear-gradient(90deg, #00ff8720, #FFD70020, #ff305620)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
            {/* Key fib lines */}
            {[0.236, 0.382, 0.5, 0.618, 0.786].map(r => (
              <div key={r} style={{
                position: 'absolute', left: `${r * 100}%`, top: 0,
                width: 1, height: '100%',
                background: r === 0.382 || r === 0.618 ? '#FFD700' : 'rgba(255,255,255,0.2)',
              }} />
            ))}
            {/* Current price marker */}
            <div style={{
              position: 'absolute',
              left: `${Math.max(0, Math.min(100, ((currentPrice - fib.swing_low) / (range || 1)) * 100))}%`,
              top: 0, width: 3, height: '100%',
              background: '#fff', transform: 'translateX(-50%)',
              boxShadow: '0 0 6px #fff',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
            <span>0% (Low)</span><span>38.2%</span><span>50%</span><span>61.8%</span><span>100% (High)</span>
          </div>
        </div>

        <div style={{ fontSize: 11, color: '#ffb800', padding: '6px 10px', background: 'rgba(255,184,0,0.07)', borderRadius: 3 }}>
          📍 {fib.currentPriceZone}
        </div>
      </div>
    </Panel>
  )
}

// ─── ATR PANEL ───────────────────────────────────────────────────────────────

function ATRPanel({ atr, direction }: { atr: any; direction: 'BUY' | 'SELL' }) {
  if (!atr) return null
  const volColor = VOLATILITY_COLOR[atr.volatility]

  return (
    <Panel title="ATR DYNAMIC TP / SL">
      <div style={{ padding: '12px 16px' }}>
        {/* ATR values */}
        <div className="grid-3col" style={{ marginBottom: 14 }}>
          {[
            ['ATR (14)', atr.atr14?.toFixed(5), '#60c0ff'],
            ['ATR (7)',  atr.atr7?.toFixed(5),  '#90d0ff'],
            ['VOLATILITY', atr.volatility, volColor],
          ].map(([label, val, color]) => (
            <div key={label as string} style={{ padding: '8px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, letterSpacing: 1 }}>{label}</div>
              <div className="mono" style={{ fontSize: 13, color: color as string, fontWeight: 700 }}>{val}</div>
            </div>
          ))}
        </div>

        {/* TP/SL levels */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 8 }}>ATR-BASED LEVELS (CURRENT PRICE)</div>

          {/* Stop Loss */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', marginBottom: 6,
            background: 'rgba(255,48,86,0.07)', border: '1px solid rgba(255,48,86,0.2)', borderRadius: 3,
          }}>
            <div>
              <div style={{ fontSize: 10, color: '#ff6060', letterSpacing: 1, marginBottom: 2 }}>STOP LOSS (1.5x ATR)</div>
              <div className="mono" style={{ fontSize: 13, color: '#ff3056' }}>
                <CopyValue value={String(direction === 'BUY' ? atr.slPrice?.buy : atr.slPrice?.sell)}>
                  {direction === 'BUY' ? atr.slPrice?.buy : atr.slPrice?.sell}
                </CopyValue>
              </div>
            </div>
            <div className="mono" style={{ fontSize: 18, color: '#ff3056', fontWeight: 700 }}>
              {atr.suggestedSL}p
            </div>
          </div>

          {/* TP levels */}
          {[
            { label: 'TP 1 (1:1.5R)', pips: atr.suggestedTP,  price: direction === 'BUY' ? atr.tp1Price?.buy : atr.tp1Price?.sell, color: '#00c060' },
            { label: 'TP 2 (1:2R)',   pips: atr.suggestedTP2, price: direction === 'BUY' ? atr.tp2Price?.buy : atr.tp2Price?.sell, color: '#00ff87' },
            { label: 'TP 3 (1:3R)',   pips: atr.suggestedTP3, price: direction === 'BUY' ? atr.tp3Price?.buy : atr.tp3Price?.sell, color: '#60ffb0' },
          ].map((tp, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', marginBottom: 6,
              background: 'rgba(0,255,135,0.05)', border: `1px solid ${tp.color}25`, borderRadius: 3,
            }}>
              <div>
                <div style={{ fontSize: 10, color: tp.color, letterSpacing: 1, marginBottom: 2 }}>{tp.label}</div>
                <div className="mono" style={{ fontSize: 13, color: tp.color }}>
                  <CopyValue value={String(tp.price)}>{tp.price}</CopyValue>
                </div>
              </div>
              <div className="mono" style={{ fontSize: 18, color: tp.color, fontWeight: 700 }}>{tp.pips}p</div>
            </div>
          ))}
        </div>

        <div style={{
          fontSize: 11, color: '#c0a060', padding: '8px 10px',
          background: 'rgba(255,184,0,0.07)', borderRadius: 3, lineHeight: 1.5,
        }}>
          💡 ATR-based levels adapt to current market volatility. Use TP2 (1:2R) as your primary target for best risk/reward.
        </div>
      </div>
    </Panel>
  )
}

// ─── CANDLESTICK PATTERNS PANEL ───────────────────────────────────────────────

function PatternsPanel({ patterns }: { patterns: any }) {
  if (!patterns) return null

  return (
    <Panel title="CANDLESTICK PATTERNS">
      <div style={{ padding: '12px 16px' }}>
        {/* Summary */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, textAlign: 'center', padding: '10px', background: 'rgba(0,255,135,0.06)', borderRadius: 3, border: '1px solid rgba(0,255,135,0.15)' }}>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: '#00ff87' }}>{patterns.bullishCount}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1 }}>BULLISH</div>
          </div>
          <div style={{ flex: 1, textAlign: 'center', padding: '10px', background: 'rgba(255,48,86,0.06)', borderRadius: 3, border: '1px solid rgba(255,48,86,0.15)' }}>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: '#ff3056' }}>{patterns.bearishCount}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1 }}>BEARISH</div>
          </div>
          <div style={{ flex: 2, padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3, display: 'flex', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>DOMINANT SIGNAL</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: SIGNAL_COLOR[patterns.dominantSignal] || '#ffb800' }}>
                {patterns.dominantSignal}
              </div>
            </div>
          </div>
        </div>

        {/* Pattern list */}
        {patterns.patterns.length === 0 ? (
          <div style={{
            padding: '20px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 13,
            background: 'rgba(0,0,0,0.1)', borderRadius: 3,
          }}>
            No significant patterns on current candle
          </div>
        ) : (
          patterns.patterns.map((p: any, i: number) => (
            <div key={i} style={{
              padding: '10px 12px', marginBottom: 8,
              background: p.signal === 'BULLISH' ? 'rgba(0,255,135,0.05)'
                : p.signal === 'BEARISH' ? 'rgba(255,48,86,0.05)'
                : 'rgba(255,184,0,0.05)',
              border: `1px solid ${p.signal === 'BULLISH' ? 'rgba(0,255,135,0.2)' : p.signal === 'BEARISH' ? 'rgba(255,48,86,0.2)' : 'rgba(255,184,0,0.2)'}`,
              borderRadius: 3,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{p.emoji}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: SIGNAL_COLOR[p.signal] }}>{p.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: STRENGTH_COLOR[p.strength],
                    background: `${STRENGTH_COLOR[p.strength]}15`,
                    padding: '2px 7px', borderRadius: 2,
                  }}>{p.strength}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.candles}c</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{p.description}</div>
            </div>
          ))
        )}

        {/* Summary note */}
        <div style={{
          marginTop: 8, fontSize: 11, color: 'var(--text-muted)',
          padding: '6px 10px', background: 'rgba(0,0,0,0.1)', borderRadius: 3,
        }}>
          📊 {patterns.summary}
        </div>
      </div>
    </Panel>
  )
}

// ─── SUPPORT & RESISTANCE PANEL ───────────────────────────────────────────────

function SRPanel({ sr }: { sr: any }) {
  if (!sr) return null
  const allLevels = [...(sr.levels || [])].sort((a: any, b: any) => b.price - a.price)

  return (
    <Panel title="SUPPORT & RESISTANCE LEVELS">
      <div style={{ padding: '12px 16px' }}>
        {/* Price action note */}
        <div style={{
          fontSize: 12, color: '#c0b060', marginBottom: 14,
          padding: '8px 12px', background: 'rgba(255,184,0,0.07)',
          border: '1px solid rgba(255,184,0,0.2)', borderRadius: 3, lineHeight: 1.5,
        }}>
          {sr.priceAction}
        </div>

        {/* Nearest key levels */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, padding: '10px 12px', background: 'rgba(255,48,86,0.06)', border: '1px solid rgba(255,48,86,0.2)', borderRadius: 3 }}>
            <div style={{ fontSize: 10, color: '#ff6060', letterSpacing: 1, marginBottom: 6 }}>NEAREST RESISTANCE</div>
            {sr.nearestResistance ? (
              <>
                <div className="mono" style={{ fontSize: 16, color: '#ff3056', fontWeight: 700 }}>{sr.nearestResistance.price.toFixed(5)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {sr.nearestResistance.distancePips}p away · touched {sr.nearestResistance.strength}×
                </div>
                <StrengthDots value={sr.nearestResistance.strength} />
              </>
            ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>None detected</div>}
          </div>
          <div style={{ flex: 1, padding: '10px 12px', background: 'rgba(0,255,135,0.05)', border: '1px solid rgba(0,255,135,0.2)', borderRadius: 3 }}>
            <div style={{ fontSize: 10, color: '#00c060', letterSpacing: 1, marginBottom: 6 }}>NEAREST SUPPORT</div>
            {sr.nearestSupport ? (
              <>
                <div className="mono" style={{ fontSize: 16, color: '#00ff87', fontWeight: 700 }}>{sr.nearestSupport.price.toFixed(5)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {sr.nearestSupport.distancePips}p away · touched {sr.nearestSupport.strength}×
                </div>
                <StrengthDots value={sr.nearestSupport.strength} />
              </>
            ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>None detected</div>}
          </div>
        </div>

        {/* All levels */}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 8 }}>ALL DETECTED LEVELS</div>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {allLevels.map((level: any, i: number) => {
            const isCurrentPrice = level.distancePips < 5
            const isRes = level.type === 'RESISTANCE'
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: isCurrentPrice ? 'rgba(255,184,0,0.05)' : 'transparent',
              }}>
                {/* Type indicator */}
                <div style={{
                  width: 4, height: 28, borderRadius: 2, flexShrink: 0,
                  background: isRes ? '#ff3056' : '#00ff87',
                  opacity: level.strength / 5,
                }} />
                {/* Price */}
                <span className="mono" style={{
                  fontSize: 13, width: 80, flexShrink: 0,
                  color: isRes ? '#ff6060' : '#00c060',
                  fontWeight: level.strength >= 3 ? 700 : 400,
                }}>
                  {level.price.toFixed(5)}
                </span>
                {/* Type badge */}
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                  color: isRes ? '#ff3056' : '#00ff87',
                  background: isRes ? 'rgba(255,48,86,0.1)' : 'rgba(0,255,135,0.1)',
                  padding: '2px 6px', borderRadius: 2, flexShrink: 0,
                }}>{level.type}</span>
                {/* Distance */}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                  {level.distancePips}p away
                </span>
                {/* Strength dots */}
                <StrengthDots value={level.strength} />
                {isCurrentPrice && (
                  <span style={{ fontSize: 9, color: '#ffb800', flexShrink: 0 }}>NEAR</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </Panel>
  )
}

// ─── CONFLUENCE SCORE ─────────────────────────────────────────────────────────

function ConfluencePanel({ analysis }: { analysis: any }) {
  const score = analysis.confluenceScore
  const bias  = analysis.overallBias
  const color = score >= 65 ? '#00ff87' : score >= 45 ? '#ffb800' : '#ff3056'
  const biasLabel = bias.replace('_', ' ')

  return (
    <Panel title="CONFLUENCE SCORE" bright>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginBottom: 16 }}>
          {/* Score circle */}
          <div style={{ position: 'relative', width: 80, height: 80, flexShrink: 0 }}>
            <svg width={80} height={80} viewBox="0 0 80 80">
              <circle cx={40} cy={40} r={34} fill="none" stroke="var(--border)" strokeWidth={6} />
              <circle
                cx={40} cy={40} r={34} fill="none"
                stroke={color} strokeWidth={6}
                strokeDasharray={`${(score / 100) * 213.6} 213.6`}
                strokeLinecap="round"
                transform="rotate(-90 40 40)"
                style={{ transition: 'stroke-dasharray 0.8s ease' }}
              />
            </svg>
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column',
            }}>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{score}</div>
              <div style={{ fontSize: 8, color: 'var(--text-muted)', letterSpacing: 0.5 }}>/ 100</div>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>OVERALL BIAS</div>
            <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'Rajdhani', letterSpacing: 1 }}>
              {biasLabel}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Based on Fib + ATR + Patterns + S/R
            </div>
          </div>
        </div>

        {/* Score bar */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4,
              background: `linear-gradient(90deg, #ff3056, #ffb800, #00ff87)`,
              width: '100%', opacity: 0.3,
            }} />
            <div style={{
              height: '100%', borderRadius: 4, marginTop: -8,
              background: color, width: `${score}%`,
              boxShadow: `0 0 8px ${color}60`,
              transition: 'width 0.8s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
            <span>Strongly Bearish</span><span>Neutral</span><span>Strongly Bullish</span>
          </div>
        </div>

        {/* Confluence notes */}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 8 }}>CONFLUENCE FACTORS</div>
        {analysis.confluenceNotes.map((note: string, i: number) => (
          <div key={i} style={{
            display: 'flex', gap: 8, padding: '5px 0',
            borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12,
          }}>
            <span style={{ color, flexShrink: 0 }}>→</span>
            <span style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>{note}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

interface AdvancedPageProps {
  prices: Record<string, any>
}

export default function AdvancedPage({ prices }: AdvancedPageProps) {
  const [pair, setPair]         = useState('EUR/USD')
  const [tf, setTf]             = useState('1H')
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY')
  const [analysis, setAnalysis] = useState<any>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const currentPrice = prices[pair]?.bid || 1.0842

  async function loadAnalysis() {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`/api/advanced?pair=${encodeURIComponent(pair)}&timeframe=${tf}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnalysis(data.analysis)
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }

  // Load on pair/tf change
  useEffect(() => { loadAnalysis() }, [pair, tf])

  // Auto refresh every 30s if enabled
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(loadAnalysis, 30000)
    return () => clearInterval(id)
  }, [autoRefresh, pair, tf])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Pair */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PAIRS.map(p => (
            <button key={p} className={`tab-btn ${pair === p ? 'active' : ''}`}
              onClick={() => setPair(p)} style={{ fontSize: 12 }}>{p}</button>
          ))}
        </div>
        {/* Timeframe */}
        <div style={{ display: 'flex', gap: 6 }}>
          {TIMEFRAMES.map(t => (
            <button key={t} className={`tab-btn ${tf === t ? 'active' : ''}`}
              onClick={() => setTf(t)} style={{ fontSize: 12 }}>{t}</button>
          ))}
        </div>
        {/* Direction */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <button className={`btn ${direction === 'BUY' ? 'btn-buy' : 'btn-ghost'}`}
            onClick={() => setDirection('BUY')} style={{ padding: '5px 16px', fontSize: 13 }}>▲ BUY</button>
          <button className={`btn ${direction === 'SELL' ? 'btn-sell' : 'btn-ghost'}`}
            onClick={() => setDirection('SELL')} style={{ padding: '5px 16px', fontSize: 13 }}>▼ SELL</button>
          {/* Auto refresh toggle */}
          <button
            className={`btn ${autoRefresh ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setAutoRefresh(a => !a)}
            style={{ padding: '5px 12px', fontSize: 11 }}
          >
            {autoRefresh ? '⟳ AUTO ON' : '⟳ AUTO OFF'}
          </button>
          <button className="btn btn-primary" onClick={loadAnalysis} disabled={loading}
            style={{ padding: '5px 16px', fontSize: 13 }}>
            {loading ? <LoadingDots /> : '↻ REFRESH'}
          </button>
        </div>
      </div>

      {/* Current price bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 20,
        padding: '10px 16px', background: 'rgba(0,128,255,0.06)',
        border: '1px solid rgba(0,128,255,0.15)', borderRadius: 3,
        flexWrap: 'wrap',
      }}>
        <div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{pair} · {tf} · </span>
          <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: '#60c0ff' }}>
            {currentPrice.toFixed(pair === 'USD/JPY' ? 3 : pair === 'XAU/USD' ? 2 : 5)}
          </span>
        </div>
        {analysis && (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              ATR: <span className="mono" style={{ color: '#ffb800' }}>{analysis.atr?.atr?.toFixed(5)}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Fib trend: <span style={{ color: analysis.fibonacci?.trend === 'BULLISH' ? '#00ff87' : '#ff3056', fontWeight: 700 }}>
                {analysis.fibonacci?.trend}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Patterns: <span style={{ color: SIGNAL_COLOR[analysis.patterns?.dominantSignal] || '#ffb800', fontWeight: 700 }}>
                {analysis.patterns?.dominantSignal}
              </span>
            </div>
          </>
        )}
        {loading && <LoadingDots color="#60c0ff" />}
      </div>

      {error && (
        <div style={{ padding: '10px 16px', background: 'rgba(255,48,86,0.08)', border: '1px solid rgba(255,48,86,0.25)', borderRadius: 3, fontSize: 13, color: '#ff6060' }}>
          ⚠ {error}
        </div>
      )}

      {/* Top row: Confluence score + Stats */}
      {analysis && (
        <>
          <div className="grid-4col">
            <StatCard
              label="FIB TREND"
              value={analysis.fibonacci?.trend || '—'}
              color={analysis.fibonacci?.trend === 'BULLISH' ? '#00ff87' : '#ff3056'}
            />
            <StatCard
              label="ATR VOLATILITY"
              value={analysis.atr?.volatility || '—'}
              color={VOLATILITY_COLOR[analysis.atr?.volatility] || '#ffb800'}
            />
            <StatCard
              label="PATTERNS"
              value={analysis.patterns?.patterns?.length > 0
                ? `${analysis.patterns.patterns.length} found`
                : 'None'}
              color={SIGNAL_COLOR[analysis.patterns?.dominantSignal] || '#ffb800'}
            />
            <StatCard
              label="S/R LEVELS"
              value={`${analysis.supportResistance?.levels?.length || 0} zones`}
              color="#60c0ff"
            />
          </div>

          {/* Confluence score full width */}
          <ConfluencePanel analysis={analysis} />

          {/* 2x2 grid of all 4 analyses */}
          <div className="grid-2col">
            <FibPanel fib={analysis.fibonacci} currentPrice={currentPrice} />
            <ATRPanel atr={analysis.atr} direction={direction} />
            <PatternsPanel patterns={analysis.patterns} />
            <SRPanel sr={analysis.supportResistance} />
          </div>
        </>
      )}

      {/* Loading state */}
      {loading && !analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 16 }}>
          <LoadingDots color="#60c0ff" />
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Calculating Fibonacci · ATR · Patterns · Support/Resistance...
          </div>
        </div>
      )}
    </div>
  )
}
