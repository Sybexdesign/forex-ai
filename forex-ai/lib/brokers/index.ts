// lib/brokers/index.ts
// Broker registry — returns the configured broker based on TRADING_BROKER env var.
// Defaults to SimulationBroker if nothing is configured.
//
// Set in .env.local:
//   TRADING_BROKER=oanda       → OANDA
//   TRADING_BROKER=alpaca      → Alpaca Markets
//   TRADING_BROKER=capital     → Capital.com
//   TRADING_BROKER=ibkr        → Interactive Brokers
//   TRADING_BROKER=simulation  → Built-in simulation (default)

import type { IBroker } from './interface'

export type BrokerKey = 'oanda' | 'alpaca' | 'capital' | 'ibkr' | 'simulation'

export const BROKER_INFO: Record<BrokerKey, {
  name: string
  description: string
  website: string
  demo: boolean
  envVars: string[]
  pairs: string[]
}> = {
  oanda: {
    name: 'OANDA',
    description: 'Leading forex broker. Free demo account with full API access.',
    website: 'https://oanda.com',
    demo: true,
    envVars: ['OANDA_API_KEY', 'OANDA_ACCOUNT_ID', 'OANDA_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'],
  },
  alpaca: {
    name: 'Alpaca Markets',
    description: 'Commission-free broker. Paper trading with no deposit required.',
    website: 'https://alpaca.markets',
    demo: true,
    envVars: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'BTC/USD', 'ETH/USD'],
  },
  capital: {
    name: 'Capital.com',
    description: 'Spread-only trading. Forex, stocks, crypto and indices. Free demo.',
    website: 'https://capital.com',
    demo: true,
    envVars: ['CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_PASSWORD', 'CAPITAL_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'BTC/USD', 'ETH/USD'],
  },
  ibkr: {
    name: 'Interactive Brokers',
    description: 'Professional-grade broker. Requires local Client Portal Gateway.',
    website: 'https://interactivebrokers.com',
    demo: true,
    envVars: ['IBKR_GATEWAY_URL', 'IBKR_ACCOUNT_ID'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'GBP/JPY', 'EUR/JPY'],
  },
  simulation: {
    name: 'Simulation',
    description: 'Built-in demo mode. No API keys needed. Realistic price simulation.',
    website: '',
    demo: true,
    envVars: [],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'BTC/USD', 'ETH/USD'],
  },
}

let _broker: IBroker | null = null

export async function getBroker(): Promise<IBroker> {
  if (_broker) return _broker

  const key = (process.env.TRADING_BROKER || 'simulation').toLowerCase() as BrokerKey

  switch (key) {
    case 'oanda': {
      const { OandaBroker } = await import('./oanda.adapter')
      _broker = new OandaBroker()
      break
    }
    case 'alpaca': {
      const { AlpacaBroker } = await import('./alpaca.adapter')
      _broker = new AlpacaBroker()
      break
    }
    case 'capital': {
      const { CapitalBroker } = await import('./capital.adapter')
      _broker = new CapitalBroker()
      break
    }
    case 'ibkr': {
      const { IBKRBroker } = await import('./ibkr.adapter')
      _broker = new IBKRBroker()
      break
    }
    default: {
      const { SimulationBroker } = await import('./simulation.adapter')
      _broker = new SimulationBroker()
    }
  }

  console.log(`[broker] Using: ${_broker.name}`)
  return _broker
}

/** Force broker refresh (useful when settings change at runtime) */
export function resetBroker() { _broker = null }

export type { IBroker } from './interface'
