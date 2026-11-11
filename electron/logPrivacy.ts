/**
 * Main-process copy of `src/wallet/logPrivacy.ts` (Electron cannot import
 * `src/`): main.log never says who the user deals with or what their
 * transactions are. `src/wallet/logPrivacy.test.ts` holds the two equal.
 */
import { createHash, randomBytes } from 'node:crypto'

export type LogKey = readonly number[]

const CACHE_MAX = 4096
const RAW_HEX_MIN = 129
const PER_DIGIT = 8
const BLOCK = 4

const BLOB = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g
const ADDRESS = /(?<![A-Za-z0-9])[13mn][1-9A-HJ-NP-Za-km-z]{24,33}(?![A-Za-z0-9])/g
const PAYMAIL = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const HANDLE = /(?<![\w$])\$[A-Za-z](?:[\w.-]*\w)?/g
const HEX = /(?<![0-9A-Za-z])[0-9A-Fa-f]{8,}(?![0-9A-Za-z])/g
const LABELLED_AMOUNT =
  /\b([a-z]*(?:sats|satoshis|balance|amount|spendable)|amt|price|fees?|paid)(["']?\s*[:=]\s*["']?)([^\s"',}\]]+)/gi
const UNIT_AMOUNT = /(?<![\w.-])(-?)(\d[\d,_]*(?:\.\d+)?)(\s?)(sats?|satoshis|BSV)\b/gi
const FIAT = /(?<![\w$])(-?)\$\d[\d,]*(?:\.\d+)?/g
const LABELLED_PEER =
  /\b(peer|sender|recipient|counterparty|counterpartyKey|friend|handle|paymail|identityKey|publicKey|pubkey|displayName)(["']?\s*[:=]\s*["']?)([^\s"',}\])]+)/gi
const LABELLED_TX = /\b(txid|txn?hash|outpoint)(["']?\s*[:=]\s*["']?)([^\s"',}\])]+)/gi

const SCRUBBED_ID = /^(?:[0-9a-f]{8,}(?:[._]\d+)?|\$h-[0-9a-f]{6}|p-[0-9a-f]{6}@paymail|id-[0-9a-f]{6}|\[[a-z]+\])$/

function mixed(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)
}

function carriesNoAmount(n: string, unit: string): boolean {
  if (/^[0,_]+(?:\.0*)?$/.test(n)) return true
  return /^sats?$/i.test(unit) && /^[0,_]*1$/.test(n)
}

function maskStart(i: number): number {
  return i < PER_DIGIT ? i : i - ((i - PER_DIGIT) % BLOCK)
}

export function newLogKey(): LogKey {
  return Array.from(randomBytes(32))
}

function prf(key: LogKey, input: string): Buffer {
  return createHash('sha256').update(Buffer.from(key)).update(input, 'latin1').digest()
}

function tag(key: LogKey, domain: string, value: string): string {
  return prf(key, `${domain}:${value.toLowerCase()}`).subarray(0, 3).toString('hex')
}

export function createLogScrubber(key: LogKey = newLogKey()): (line: string) => string {
  const hexCache = new Map<string, string>()

  const hexPseudonym = (value: string): string => {
    const lower = value.toLowerCase()
    const hit = hexCache.get(lower)
    if (hit) return hit
    let out = ''
    let masksFrom = -1
    let masks: Buffer = Buffer.alloc(0)
    for (let i = 0; i < lower.length; i++) {
      const from = maskStart(i)
      if (from !== masksFrom) {
        masks = prf(key, `x:${lower.slice(0, from)}`)
        masksFrom = from
      }
      out += ((parseInt(lower[i]!, 16) + masks[i - from]!) & 15).toString(16)
    }
    if (hexCache.size >= CACHE_MAX) hexCache.clear()
    hexCache.set(lower, out)
    return out
  }

  return (line: string): string =>
    line
      .replace(BLOB, (m) => (/^[0-9A-Fa-f]+$/.test(m) || !mixed(m) ? m : '[blob]'))
      .replace(ADDRESS, (m) => (mixed(m) ? '[address]' : m))
      .replace(PAYMAIL, (m) => (/^p-[0-9a-f]{6}@paymail$/.test(m) ? m : `p-${tag(key, 'p', m)}@paymail`))
      .replace(HANDLE, (m) => (/^\$h-[0-9a-f]{6}$/.test(m) ? m : `$h-${tag(key, 'h', m.slice(1))}`))
      .replace(HEX, (m) => {
        if (m.length >= RAW_HEX_MIN) return '[hex]'
        if (!/\d/.test(m) || !/[a-f]/i.test(m)) return m
        return hexPseudonym(m)
      })
      .replace(LABELLED_AMOUNT, (_m, label: string, sep: string) => `${label}${sep}[amt]`)
      .replace(UNIT_AMOUNT, (m, sign: string, n: string, space: string, unit: string) =>
        carriesNoAmount(n, unit) ? m : `${sign}[amt]${space}${unit}`,
      )
      .replace(FIAT, (_m, sign: string) => `${sign}$[amt]`)
      .replace(LABELLED_PEER, (_m, label: string, sep: string, value: string) =>
        `${label}${sep}${SCRUBBED_ID.test(value) ? value : `id-${tag(key, 'i', value)}`}`,
      )
      .replace(LABELLED_TX, (_m, label: string, sep: string, value: string) =>
        `${label}${sep}${SCRUBBED_ID.test(value) ? value : '[REDACTED]'}`,
      )
}
