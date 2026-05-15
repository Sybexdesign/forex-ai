// lib/brokers/mt5direct.adapter.ts
// Receives balance pushes from an MT5 Expert Advisor via webhook.
// No MetaApi or third-party service required.

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'
import { createClient } from '@supabase/supabase-js'

interface Mt5DirectConfig {
  webhookToken?: string
  balance?: string
  equity?: string
  currency?: string
  login?: string
  server?: string
  updatedAt?: string
  _configId?: string
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export class Mt5DirectBroker implements IBroker {
  name = 'MT5 Direct'
  supportedPairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY']
  private config: Mt5DirectConfig

  constructor(config: Mt5DirectConfig) {
    this.config = config
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const balance = parseFloat(this.config.balance || '0')
    const equity = parseFloat(this.config.equity || String(balance))
    return {
      balance,
      unrealizedPL: equity - balance,
      realizedPL: 0,
      openTradeCount: 0,
      currency: this.config.currency || 'USD',
      nav: equity,
    }
  }

  async getPrices(pairs: string[]): Promise<Price[]> {
    try {
      const { CapitalBroker } = await import('./capital.adapter')
      return new CapitalBroker().getPrices(pairs)
    } catch { return [] }
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    try {
      const { CapitalBroker } = await import('./capital.adapter')
      return new CapitalBroker().getCandles(pair, timeframe, count)
    } catch { return [] }
  }

  async getOpenTrades(): Promise<OpenTrade[]> { return [] }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.config._configId) {
      return { success: false, error: 'MT5 Direct: missing _configId — cannot queue order' }
    }

    const orderId = crypto.randomUUID()
    const pip = getPipValue(req.pair)
    const sign = req.direction === 'BUY' ? 1 : -1
    const dp = req.pair.includes('JPY') ? 3 : req.pair.startsWith('XAU') ? 2 : 5
    const slPrice = +(req.currentPrice - req.stopLossPips * pip * sign).toFixed(dp)
    const tpPrice = +(req.currentPrice + req.takeProfitPips * pip * sign).toFixed(dp)

    const newOrder = {
      id: orderId,
      symbol: req.pair.replace('/', ''),
      direction: req.direction,
      lots: req.lots,
      slPips: req.stopLossPips,
      tpPips: req.takeProfitPips,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }

    try {
      const sb = getServiceClient()
      const { data: row } = await sb
        .from('broker_configs')
        .select('config')
        .eq('id', this.config._configId)
        .single()
      const pending = (row?.config?.pendingOrders || []) as typeof newOrder[]
      pending.push(newOrder)
      await sb
        .from('broker_configs')
        .update({ config: { ...row?.config, pendingOrders: pending } })
        .eq('id', this.config._configId)

      return {
        success: true,
        orderId,
        tradeId: orderId,
        filledPrice: req.currentPrice,
        tpPrice,
        slPrice,
      }
    } catch (e: any) {
      return { success: false, error: `Failed to queue order: ${e.message}` }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    if (!this.config._configId) {
      return { success: false, error: 'MT5 Direct: missing _configId — cannot queue close command' }
    }

    try {
      const sb = getServiceClient()

      // Get config row + user_id so we can look up the trade symbol
      const { data: row } = await sb
        .from('broker_configs')
        .select('id, user_id, config')
        .eq('id', this.config._configId)
        .single()

      if (!row) return { success: false, error: 'Broker config not found' }

      // Look up the trade to get the MT5 symbol (needed for EA close)
      let symbol = ''
      if (row.user_id) {
        const { data: trade } = await sb
          .from('trades')
          .select('pair')
          .eq('user_id', row.user_id)
          .or(`oanda_trade_id.eq.${tradeId},id.eq.${tradeId}`)
          .maybeSingle()
        if (trade?.pair) symbol = trade.pair.replace('/', '')
      }

      const closeCommand = {
        id: crypto.randomUUID(),
        type: 'close',
        symbol,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }

      const pending = (row?.config?.pendingOrders || []) as typeof closeCommand[]
      pending.push(closeCommand)
      await sb
        .from('broker_configs')
        .update({ config: { ...row.config, pendingOrders: pending } })
        .eq('id', this.config._configId)

      return { success: true }
    } catch (e: any) {
      return { success: false, error: `Failed to queue close: ${e.message}` }
    }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
