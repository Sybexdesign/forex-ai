// lib/propfirm.ts — Prop-firm evaluation risk rules (FTMO, Funded Next, Funding Pips, Equity Edge, etc.)

export interface PropFirmSettings {
  enabled: boolean
  firmType: 'ftmo' | 'mff' | 'the5ers' | 'equityedge' | 'custom'
  phase: 'evaluation' | 'verification' | 'funded'
  accountSize: number
  initialBalance: number
  maxDailyLossPct: number
  maxTotalDrawdownPct: number
  profitTargetPct: number
  minTradingDays: number
  noOvernight: boolean
  noWeekend: boolean
  newsRestriction: boolean
  consistencyRulePct: number
}

export interface PropFirmStatus {
  dailyLoss: number
  dailyLossPct: number
  dailyLossLimit: number
  dailyLossLimitHit: boolean
  totalDrawdown: number
  totalDrawdownPct: number
  totalDrawdownLimit: number
  maxDrawdownHit: boolean
  profitToDate: number
  profitPct: number
  profitTarget: number
  targetReached: boolean
  tradingDaysCount: number
  minTradingDaysMet: boolean
  consistencyOk: boolean
  passedEvaluation: boolean
  blockReasons: string[]
  warnReasons: string[]
}

export const FIRM_PRESETS: Record<string, Omit<PropFirmSettings, 'enabled' | 'firmType' | 'phase' | 'accountSize' | 'initialBalance'>> = {
  ftmo: {
    maxDailyLossPct: 5,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 10,
    minTradingDays: 4,
    noOvernight: false,
    noWeekend: false,
    newsRestriction: false,
    consistencyRulePct: 0,
  },
  mff: {
    maxDailyLossPct: 5,
    maxTotalDrawdownPct: 12,
    profitTargetPct: 8,
    minTradingDays: 5,
    noOvernight: false,
    noWeekend: false,
    newsRestriction: false,
    consistencyRulePct: 0,
  },
  the5ers: {
    maxDailyLossPct: 4,
    maxTotalDrawdownPct: 8,
    profitTargetPct: 6,
    minTradingDays: 0,
    noOvernight: false,
    noWeekend: false,
    newsRestriction: false,
    consistencyRulePct: 0,
  },
  equityedge: {
    maxDailyLossPct: 3,       // 3% max daily loss
    maxTotalDrawdownPct: 5,   // 5% trailing max loss
    profitTargetPct: 10,      // verify with your account dashboard
    minTradingDays: 7,        // 7 minimum trading days
    noOvernight: false,
    noWeekend: false,
    newsRestriction: false,
    consistencyRulePct: 15,   // no single day > 15% of total profit
  },
  custom: {
    maxDailyLossPct: 5,
    maxTotalDrawdownPct: 10,
    profitTargetPct: 10,
    minTradingDays: 4,
    noOvernight: false,
    noWeekend: false,
    newsRestriction: true,
    consistencyRulePct: 50,
  },
}

export function calcPropFirmStatus(
  settings: PropFirmSettings,
  todayPL: number,
  allTimePL: number,
  tradingDays: number,
  maxDailyPLEver: number,
): PropFirmStatus {
  const { accountSize, initialBalance, maxDailyLossPct, maxTotalDrawdownPct, profitTargetPct, minTradingDays, consistencyRulePct } = settings

  const dailyLossLimit = accountSize * (maxDailyLossPct / 100)
  const totalDrawdownLimit = initialBalance * (maxTotalDrawdownPct / 100)
  const profitTarget = initialBalance * (profitTargetPct / 100)

  const dailyLoss = Math.min(0, todayPL)
  const dailyLossPct = Math.abs(dailyLoss / accountSize) * 100
  const dailyLossLimitHit = Math.abs(dailyLoss) >= dailyLossLimit

  const totalDrawdown = Math.min(0, allTimePL)
  const totalDrawdownPct = Math.abs(totalDrawdown / initialBalance) * 100
  const maxDrawdownHit = Math.abs(totalDrawdown) >= totalDrawdownLimit

  const profitToDate = Math.max(0, allTimePL)
  const profitPct = (profitToDate / initialBalance) * 100
  const targetReached = profitToDate >= profitTarget

  const minTradingDaysMet = tradingDays >= minTradingDays

  // Consistency rule: no single day > X% of total profit
  const consistencyOk = consistencyRulePct === 0 || profitToDate === 0
    ? true
    : maxDailyPLEver <= profitToDate * (consistencyRulePct / 100)

  const blockReasons: string[] = []
  const warnReasons: string[] = []

  if (dailyLossLimitHit) {
    blockReasons.push(`Daily loss limit hit: ${dailyLossPct.toFixed(1)}% / ${maxDailyLossPct}% — trading blocked for today`)
  } else if (dailyLossPct >= maxDailyLossPct * 0.75) {
    warnReasons.push(`Approaching daily loss limit: ${dailyLossPct.toFixed(1)}% of ${maxDailyLossPct}% used`)
  }

  if (maxDrawdownHit) {
    blockReasons.push(`Max drawdown exceeded: ${totalDrawdownPct.toFixed(1)}% / ${maxTotalDrawdownPct}% — account failed`)
  } else if (totalDrawdownPct >= maxTotalDrawdownPct * 0.75) {
    warnReasons.push(`Approaching max drawdown: ${totalDrawdownPct.toFixed(1)}% of ${maxTotalDrawdownPct}% used`)
  }

  const now = new Date()
  const day = now.getUTCDay()
  const isWeekend = (day === 5 && now.getUTCHours() >= 21) || day === 6 || (day === 0 && now.getUTCHours() < 21)
  if (settings.noWeekend && isWeekend) {
    blockReasons.push('Weekend trading not allowed on this prop firm account')
  }

  if (settings.noOvernight && !isWeekend && now.getUTCHours() >= 21) {
    blockReasons.push('No overnight positions allowed after 21:00 UTC — prop firm rule')
  }

  if (!consistencyOk) {
    blockReasons.push(`Consistency rule breached: a single day's profit exceeds ${consistencyRulePct}% of total gains — trading blocked to protect payout eligibility`)
  }

  const passedEvaluation = !blockReasons.length && targetReached && minTradingDaysMet

  return {
    dailyLoss, dailyLossPct, dailyLossLimit, dailyLossLimitHit,
    totalDrawdown, totalDrawdownPct, totalDrawdownLimit, maxDrawdownHit,
    profitToDate, profitPct, profitTarget, targetReached,
    tradingDaysCount: tradingDays, minTradingDaysMet,
    consistencyOk, passedEvaluation, blockReasons, warnReasons,
  }
}

export function applyPropFirmGuards(
  settings: PropFirmSettings,
  status: PropFirmStatus,
): { allowed: boolean; reasons: string[] } {
  if (!settings.enabled) return { allowed: true, reasons: [] }
  if (status.blockReasons.length > 0) return { allowed: false, reasons: status.blockReasons }
  return { allowed: true, reasons: status.warnReasons }
}

export const DEFAULT_PROP_FIRM: PropFirmSettings = {
  enabled: false,
  firmType: 'ftmo',
  phase: 'evaluation',
  accountSize: 10000,
  initialBalance: 10000,
  ...FIRM_PRESETS.ftmo,
}
