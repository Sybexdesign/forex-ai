// lib/instruments.ts — Central instrument registry: pairs, labels, sessions

export type InstrumentGroup = 'Majors' | 'Crosses' | 'Commodities' | 'Indices'

export const PAIR_GROUPS: Record<InstrumentGroup, string[]> = {
  Majors: [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'NZD/USD',
    'USD/CAD', 'USD/CHF', 'XAU/USD',
  ],
  Crosses: [
    'EUR/JPY', 'GBP/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD',
    'EUR/GBP', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD',
    'AUD/JPY', 'AUD/NZD', 'CAD/JPY', 'NZD/JPY', 'CHF/JPY',
  ],
  Commodities: ['XAG/USD', 'BCO/USD'],
  Indices:     ['SPX500', 'NAS100', 'UK100', 'GER40', 'JP225'],
}

export const PAIR_LABELS: Record<string, string> = {
  // Majors
  'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
  'AUD/USD': 'AUD/USD', 'NZD/USD': 'NZD/USD', 'USD/CAD': 'USD/CAD',
  'USD/CHF': 'USD/CHF', 'XAU/USD': 'XAU/USD',
  // Crosses
  'EUR/JPY': 'EUR/JPY', 'GBP/JPY': 'GBP/JPY', 'EUR/AUD': 'EUR/AUD',
  'EUR/CAD': 'EUR/CAD', 'EUR/NZD': 'EUR/NZD', 'EUR/GBP': 'EUR/GBP',
  'GBP/AUD': 'GBP/AUD', 'GBP/CAD': 'GBP/CAD', 'GBP/NZD': 'GBP/NZD',
  'AUD/JPY': 'AUD/JPY', 'AUD/NZD': 'AUD/NZD', 'CAD/JPY': 'CAD/JPY',
  'NZD/JPY': 'NZD/JPY', 'CHF/JPY': 'CHF/JPY',
  // Commodities
  'XAG/USD': 'Silver XAG/USD', 'BCO/USD': 'Oil Brent',
  // Indices
  'SPX500': 'SPX500', 'NAS100': 'NAS100',
  'UK100': 'UK100', 'GER40': 'GER40', 'JP225': 'JP225',
}

export const ALL_PAIRS = Object.values(PAIR_GROUPS).flat()

export const HIGH_VOLATILITY_PAIRS = new Set(['GBP/JPY', 'GBP/NZD', 'GBP/AUD'])

export function isIndex(pair: string): boolean {
  return ['SPX500', 'NAS100', 'UK100', 'GER40', 'JP225', 'US30'].includes(pair)
}

interface IndexSession {
  name: string
  hours: string
  utcOpen: number   // minutes since midnight UTC
  utcClose: number
}

const INDEX_SESSIONS: Record<string, IndexSession> = {
  SPX500: { name: 'US Market',   hours: '9:30 AM–4:00 PM EST (14:30–21:00 UTC)', utcOpen: 14*60+30, utcClose: 21*60 },
  NAS100: { name: 'US Market',   hours: '9:30 AM–4:00 PM EST (14:30–21:00 UTC)', utcOpen: 14*60+30, utcClose: 21*60 },
  US30:   { name: 'US Market',   hours: '9:30 AM–4:00 PM EST (14:30–21:00 UTC)', utcOpen: 14*60+30, utcClose: 21*60 },
  UK100:  { name: 'London',      hours: '8:00 AM–4:30 PM GMT (08:00–16:30 UTC)', utcOpen: 8*60,     utcClose: 16*60+30 },
  GER40:  { name: 'Frankfurt',   hours: '9:00 AM–5:30 PM CET (08:00–16:30 UTC)', utcOpen: 8*60,     utcClose: 16*60+30 },
  JP225:  { name: 'Tokyo',       hours: '9:00 AM–3:00 PM JST (00:00–06:00 UTC)', utcOpen: 0,        utcClose: 6*60 },
}

export function getIndexSession(pair: string): IndexSession | null {
  return INDEX_SESSIONS[pair] ?? null
}

export function isIndexInSession(pair: string): boolean {
  const session = INDEX_SESSIONS[pair]
  if (!session) return true
  const now = new Date()
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  return mins >= session.utcOpen && mins <= session.utcClose
}

export function getPairDecimalPlaces(pair: string): number {
  if (isIndex(pair))           return 1
  if (pair.startsWith('BCO')) return 2
  if (pair.includes('JPY'))   return 3
  if (pair.startsWith('XAU')) return 2
  if (pair.startsWith('XAG')) return 2
  return 5
}
