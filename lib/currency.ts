// lib/currency.ts
// Currency symbol/formatting helpers — maps broker currency codes to display symbols.

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
  AUD: 'A$',
  NZD: 'NZ$',
  CAD: 'C$',
  CHF: 'CHF ',
  CNY: '¥',
  HKD: 'HK$',
  SGD: 'S$',
  SEK: 'kr ',
  NOK: 'kr ',
  DKK: 'kr ',
  PLN: 'zł ',
  ZAR: 'R ',
  MXN: 'MX$',
  BRL: 'R$ ',
  INR: '₹',
  RUB: '₽',
  TRY: '₺',
  KRW: '₩',
  THB: '฿',
  IDR: 'Rp ',
  MYR: 'RM ',
  PHP: '₱',
  VND: '₫',
  AED: 'د.إ ',
  SAR: '﷼ ',
  ILS: '₪',
  BTC: '₿',
  ETH: 'Ξ',
}

/**
 * Returns the display symbol for a currency code.
 * Falls back to '$' for USD and unknown codes (most brokers default to USD).
 */
export function currencySymbol(currency?: string | null): string {
  if (!currency) return '$'
  const code = currency.toUpperCase()
  return CURRENCY_SYMBOLS[code] ?? '$'
}

/**
 * Formats a number with the account's currency symbol.
 * e.g. currencyFormat(1234.5, 'GBP') → '£1,234.50'
 */
export function currencyFormat(value: number, currency?: string | null, decimals = 2): string {
  const sym = currencySymbol(currency)
  return `${sym}${value.toLocaleString('en', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

/**
 * Formats a signed P/L value with the account's currency symbol.
 * e.g. currencySigned(123.45, 'GBP') → '+£123.45'
 */
export function currencySigned(value: number, currency?: string | null, decimals = 2): string {
  const sym = currencySymbol(currency)
  const sign = value >= 0 ? '+' : ''
  return `${sign}${sym}${Math.abs(value).toLocaleString('en', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}
