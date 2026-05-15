// lib/brokers/index.ts
import type { IBroker } from './interface'
import { createClient } from '@supabase/supabase-js'

export type BrokerKey = 'oanda' | 'alpaca' | 'capital' | 'ibkr' | 'mt5direct' | 'exness' | 'simulation'

export const BROKER_INFO: Record<BrokerKey, {
  name: string
  description: string
  website: string
  demo: boolean
  envVars: string[]
  pairs: string[]
  fields: Array<{ key: string; label: string; placeholder: string; secret?: boolean }>
}> = {
  oanda: {
    name: 'OANDA',
    description: 'Leading forex broker. Free demo account with full API access.',
    website: 'https://oanda.com',
    demo: true,
    envVars: ['OANDA_API_KEY', 'OANDA_ACCOUNT_ID', 'OANDA_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'],
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Your OANDA access token', secret: true },
      { key: 'accountId', label: 'Account ID', placeholder: '001-001-12345678-001' },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api-fxpractice.oanda.com' },
    ],
  },
  alpaca: {
    name: 'Alpaca Markets',
    description: 'Commission-free broker. Paper trading with no deposit required.',
    website: 'https://alpaca.markets',
    demo: true,
    envVars: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'BTC/USD', 'ETH/USD'],
    fields: [
      { key: 'apiKey', label: 'API Key ID', placeholder: 'PKTEST1234567890' },
      { key: 'secretKey', label: 'Secret Key', placeholder: 'Your secret key', secret: true },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://paper-api.alpaca.markets' },
    ],
  },
  capital: {
    name: 'Capital.com',
    description: 'Spread-only trading. Forex, stocks, crypto and indices. Free demo.',
    website: 'https://capital.com',
    demo: true,
    envVars: ['CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_PASSWORD', 'CAPITAL_BASE_URL'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'],
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'From Capital.com dashboard' },
      { key: 'identifier', label: 'Email', placeholder: 'your@email.com' },
      { key: 'password', label: 'Password', placeholder: 'Your Capital.com password', secret: true },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api-capital.backend-capital.com/api' },
    ],
  },
  ibkr: {
    name: 'Interactive Brokers',
    description: 'Professional-grade broker. Requires local Client Portal Gateway.',
    website: 'https://interactivebrokers.com',
    demo: true,
    envVars: ['IBKR_GATEWAY_URL', 'IBKR_ACCOUNT_ID'],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'GBP/JPY', 'EUR/JPY'],
    fields: [
      { key: 'gatewayUrl', label: 'Gateway URL', placeholder: 'https://localhost:5000' },
      { key: 'accountId', label: 'Account ID', placeholder: 'U12345678' },
    ],
  },
  mt5direct: {
    name: 'MT5 Direct (EA)',
    description: 'Connect MT5 directly via a free Expert Advisor. No MetaApi needed. Works with FTMO and any MT5 broker.',
    website: '',
    demo: false,
    envVars: [],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'],
    fields: [
      { key: 'webhookToken', label: 'Webhook Token', placeholder: 'Auto-generated', secret: false },
    ],
  },
  exness: {
    name: 'Exness (MT5)',
    description: 'Connect your Exness MT5 account via a free Expert Advisor. Balance syncs automatically and trades execute directly from the app.',
    website: 'https://www.exness.uk',
    demo: true,
    envVars: [],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'],
    fields: [{ key: 'webhookToken', label: 'Webhook Token', placeholder: 'Auto-generated', secret: false }],
  },
  simulation: {
    name: 'Simulation',
    description: 'Built-in demo mode. No API keys needed. Realistic price simulation.',
    website: '',
    demo: true,
    envVars: [],
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'BTC/USD', 'ETH/USD'],
    fields: [],
  },
}

let _defaultBroker: IBroker | null = null

async function instantiateBroker(key: string, config?: Record<string, string>): Promise<IBroker> {
  switch (key) {
    case 'oanda': {
      const { OandaBroker } = await import('./oanda.adapter')
      return new OandaBroker()
    }
    case 'alpaca': {
      const { AlpacaBroker } = await import('./alpaca.adapter')
      return new AlpacaBroker()
    }
    case 'capital': {
      const { CapitalBroker } = await import('./capital.adapter')
      return new CapitalBroker()
    }
    case 'ibkr': {
      const { IBKRBroker } = await import('./ibkr.adapter')
      return new IBKRBroker()
    }
    case 'mt5direct': {
      const { Mt5DirectBroker } = await import('./mt5direct.adapter')
      return new Mt5DirectBroker(config || {})
    }
    case 'exness': {
      const { Mt5DirectBroker } = await import('./mt5direct.adapter')
      return new Mt5DirectBroker(config || {})
    }
    default: {
      const { SimulationBroker } = await import('./simulation.adapter')
      return new SimulationBroker()
    }
  }
}

// Load broker for a specific user (from DB) or fall back to env default
export async function getBroker(authToken?: string): Promise<IBroker> {
  if (authToken) {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      const userClient = createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${authToken}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data } = await userClient
        .from('broker_configs')
        .select('id, broker_type, config')
        .eq('is_active', true)
        .single()
      if (data) {
        const broker = await instantiateBroker(data.broker_type, { ...data.config, _configId: data.id })
        console.log(`[broker] User config: ${broker.name}`)
        return broker
      }
    } catch { /* fall through to default */ }
  }

  if (_defaultBroker) return _defaultBroker
  const key = (process.env.TRADING_BROKER || 'simulation').toLowerCase()
  _defaultBroker = await instantiateBroker(key)
  console.log(`[broker] Default: ${_defaultBroker.name}`)
  return _defaultBroker
}

export function resetBroker() { _defaultBroker = null }
export type { IBroker } from './interface'
