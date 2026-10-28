/**
 * Preferred government / fiat currency for portfolio totals and "show in fiat"
 * display. Independent of DisplayCurrency (`usd` | `bsv`), which only chooses
 * fiat-vs-coins; this picks *which* fiat.
 */

const STORAGE_KEY = 'handcash.brc100.fiatCurrency'

export const FIAT_CODES = [
  'usd',
  'eur',
  'gbp',
  'jpy',
  'cad',
  'aud',
  'chf',
  'cny',
  'inr',
  'brl',
  'mxn',
  'krw',
] as const

export type FiatCode = (typeof FIAT_CODES)[number]

export type FiatOption = {
  code: FiatCode
  /** ISO 4217 for Intl.NumberFormat */
  iso: string
  name: string
  /** Regional indicator emoji */
  flag: string
  locale: string
}

export const FIAT_OPTIONS: readonly FiatOption[] = [
  { code: 'usd', iso: 'USD', name: 'US Dollar', flag: '🇺🇸', locale: 'en-US' },
  { code: 'eur', iso: 'EUR', name: 'Euro', flag: '🇪🇺', locale: 'en-IE' },
  { code: 'gbp', iso: 'GBP', name: 'British Pound', flag: '🇬🇧', locale: 'en-GB' },
  { code: 'jpy', iso: 'JPY', name: 'Japanese Yen', flag: '🇯🇵', locale: 'ja-JP' },
  { code: 'cad', iso: 'CAD', name: 'Canadian Dollar', flag: '🇨🇦', locale: 'en-CA' },
  { code: 'aud', iso: 'AUD', name: 'Australian Dollar', flag: '🇦🇺', locale: 'en-AU' },
  { code: 'chf', iso: 'CHF', name: 'Swiss Franc', flag: '🇨🇭', locale: 'de-CH' },
  { code: 'cny', iso: 'CNY', name: 'Chinese Yuan', flag: '🇨🇳', locale: 'zh-CN' },
  { code: 'inr', iso: 'INR', name: 'Indian Rupee', flag: '🇮🇳', locale: 'en-IN' },
  { code: 'brl', iso: 'BRL', name: 'Brazilian Real', flag: '🇧🇷', locale: 'pt-BR' },
  { code: 'mxn', iso: 'MXN', name: 'Mexican Peso', flag: '🇲🇽', locale: 'es-MX' },
  { code: 'krw', iso: 'KRW', name: 'Korean Won', flag: '🇰🇷', locale: 'ko-KR' },
] as const

const byCode = Object.fromEntries(FIAT_OPTIONS.map((o) => [o.code, o])) as Record<
  FiatCode,
  FiatOption
>

type Listener = (code: FiatCode) => void

const listeners = new Set<Listener>()

function isFiatCode(raw: string): raw is FiatCode {
  return (FIAT_CODES as readonly string[]).includes(raw)
}

function read(): FiatCode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && isFiatCode(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'usd'
}

let current: FiatCode = read()

function write(code: FiatCode) {
  current = code
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb(code)
}

export function getFiatCurrency(): FiatCode {
  return current
}

export function getFiatOption(code: FiatCode = current): FiatOption {
  return byCode[code]
}

/** Narrow currency mark for amount fields (`$`, `£`, `¥`, …). */
export function getFiatSymbol(code: FiatCode = current): string {
  const opt = byCode[code]
  try {
    const part = new Intl.NumberFormat(opt.locale, {
      style: 'currency',
      currency: opt.iso,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    if (part?.value) return part.value
  } catch {
    /* fall through */
  }
  return opt.iso
}

export function setFiatCurrency(code: FiatCode) {
  if (code === current) return
  write(code)
}

export function subscribeFiatCurrency(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
