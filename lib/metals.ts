// lib/metals.ts
// Gold (XAU/USD) and Silver (XAG/USD) specific trading config
// Metals behave very differently from forex pairs — different pip values,
// position sizing, lot sizes, and market drivers

export const METALS = ['XAU/USD', 'XAG/USD'] as const
export type Metal = typeof METALS[number]

export const METAL_CONFIG = {
  'XAU/USD': {
    name: 'Gold',
    symbol: 'XAU',
    emoji: '🥇',
    color: '#FFD700',
    dimColor: '#B8960C',
    bgColor: 'rgba(255,215,0,0.08)',
    borderColor: 'rgba(255,215,0,0.25)',
    pipSize: 0.1,           // 1 pip = $0.10 for gold
    pipValuePerLot: 10,     // $10 per pip per standard lot (100oz)
    lotSize: 100,           // 1 lot = 100 troy ounces
    minLot: 0.01,           // minimum 0.01 lots = 1 oz
    tickSize: 0.01,
    decimals: 2,
    spread: 0.4,            // typical spread in USD
    spreadUnit: '$',
    marginRate: 0.05,       // 5% margin (20:1 leverage)
    sessionPeak: 'London + NY overlap (13:00–17:00 UTC)',
    description: 'Gold — safe haven asset, USD-correlated, inflation hedge',
    drivers: [
      'US Dollar strength (inverse correlation)',
      'Real interest rates / Fed policy',
      'Geopolitical risk / safe haven demand',
      'Inflation expectations (CPI, PCE)',
      'Central bank gold purchases',
      'ETF flows (GLD, IAU)',
    ],
    oandaSymbol: 'XAU_USD',
    tipNote: 'Gold moves $10+ per pip per lot. Use smaller lot sizes than forex.',
  },
  'XAG/USD': {
    name: 'Silver',
    symbol: 'XAG',
    emoji: '🥈',
    color: '#C0C0C0',
    dimColor: '#909090',
    bgColor: 'rgba(192,192,192,0.08)',
    borderColor: 'rgba(192,192,192,0.2)',
    pipSize: 0.01,
    pipValuePerLot: 50,     // $50 per pip per standard lot (5000oz)
    lotSize: 5000,          // 1 lot = 5000 troy ounces
    minLot: 0.01,
    tickSize: 0.001,
    decimals: 3,
    spread: 0.03,
    spreadUnit: '$',
    marginRate: 0.05,
    sessionPeak: 'London + NY overlap (13:00–17:00 UTC)',
    description: 'Silver — industrial + precious metal hybrid',
    drivers: [
      'Gold price direction (high correlation ~0.85)',
      'Industrial demand (solar panels, electronics)',
      'Gold/Silver ratio (currently ~80–90x)',
      'US Dollar strength',
      'Inflation and real rates',
      'Mining supply disruptions',
    ],
    oandaSymbol: 'XAG_USD',
    tipNote: 'Silver is more volatile than gold. Gold/Silver ratio is a key signal.',
  },
}

export function isMetal(pair: string): boolean {
  return pair === 'XAU/USD' || pair === 'XAG/USD'
}

export function getMetalConfig(pair: string) {
  return METAL_CONFIG[pair as Metal] || null
}

// Gold-specific pip and position size calculations
export function goldPipValue(pair: string): number {
  return METAL_CONFIG[pair as Metal]?.pipSize || 0.0001
}

export function goldPositionSize(
  balance: number,
  riskPct: number,
  slPips: number,
  pair: string
): number {
  const cfg = METAL_CONFIG[pair as Metal]
  if (!cfg) return 0.01
  const riskUSD = balance * (riskPct / 100)
  const pipValPerLot = cfg.pipValuePerLot
  const lots = riskUSD / (slPips * pipValPerLot)
  return +Math.max(cfg.minLot, Math.min(lots, 10)).toFixed(2)
}

// Gold/Silver ratio analysis
export function goldSilverRatio(goldPrice: number, silverPrice: number): {
  ratio: number
  signal: 'BUY_SILVER' | 'BUY_GOLD' | 'NEUTRAL'
  interpretation: string
} {
  const ratio = +(goldPrice / silverPrice).toFixed(1)
  if (ratio > 90) return {
    ratio,
    signal: 'BUY_SILVER',
    interpretation: `Ratio at ${ratio}x — historically high. Silver historically cheap vs Gold.`,
  }
  if (ratio < 65) return {
    ratio,
    signal: 'BUY_GOLD',
    interpretation: `Ratio at ${ratio}x — historically low. Gold may be cheap vs Silver.`,
  }
  return {
    ratio,
    signal: 'NEUTRAL',
    interpretation: `Ratio at ${ratio}x — within normal historical range (65–90x).`,
  }
}

// DXY correlation note for AI prompt
export function goldAIContext(pair: string, price: number): string {
  const cfg = METAL_CONFIG[pair as Metal]
  if (!cfg) return ''
  const isGold = pair === 'XAU/USD'
  return `
METAL TRADING CONTEXT:
- Asset: ${cfg.name} (${pair})
- Current price: $${price.toFixed(cfg.decimals)} per troy ounce
- Pip size: $${cfg.pipSize} | Pip value per lot: $${cfg.pipValuePerLot}
- Lot size: ${cfg.lotSize} troy ounces
- Key market drivers: ${cfg.drivers.slice(0, 4).join(', ')}
- Peak liquidity session: ${cfg.sessionPeak}
${isGold ? `
GOLD-SPECIFIC RULES:
- Gold has strong INVERSE correlation with USD (DXY). Rising DXY = bearish gold.
- Real interest rates matter most — rising real yields = bearish gold.
- Safe haven demand spikes during geopolitical events, market crashes.
- $2000 and $2100 are key psychological resistance levels.
- Gold above $2300 is historically elevated — tighter stops recommended.
- Use smaller lot sizes: 1 pip = $${cfg.pipValuePerLot} per lot (10x more than EUR/USD).
` : `
SILVER-SPECIFIC RULES:  
- Silver tracks gold closely but with 2-3x the volatility.
- Gold/Silver ratio above 90x historically favors buying silver.
- Industrial demand adds unique seasonal patterns (Q1 solar demand).
- Silver is thinner market — wider spreads, faster moves.
- 1 pip = $${cfg.pipValuePerLot} per lot. Position size accordingly.
`}`.trim()
}
