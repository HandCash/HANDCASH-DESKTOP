import { Utils } from '@bsv/sdk'
import { compactFromTarget } from '../ltc/headers'
import { concat, decodeSegwitAddress, encodeSegwitAddress, hash160, LtcFormatError, p2wpkhScript, targetFromBits, type Bytes } from '../ltc/litecoin'

/**
 * Bitcoin mainnet primitives. Transactions, segwit, BIP143 signing, headers
 * and merkle proofs share Litecoin's formats (`ltc/litecoin.ts`); what differs
 * is the address prefix, double SHA-256 proof of work, and the retarget
 * window's length and limit.
 */

const fail = (message: string): never => {
  throw new LtcFormatError(message)
}

/** Satoshis as a BTC decimal string, trailing zeros dropped. */
export function formatBtc(sats: bigint): string {
  const whole = sats / 100_000_000n
  const frac = (sats % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export const BTC_HRP = 'bc'
const P2SH_VERSION = 0x05

/** The wallet's own Bitcoin address: native segwit (P2WPKH) of a compressed key. */
export function btcCoinAddress(pubkey: Bytes): string {
  if (pubkey.length !== 33) fail('a P2WPKH key is a compressed public key')
  return encodeSegwitAddress(BTC_HRP, 0, hash160(pubkey))
}

export const btcCoinScript = p2wpkhScript

/**
 * The output script a payment to `address` locks: `bc1` segwit v0 (P2WPKH,
 * P2WSH) or v1 (taproot), or a `3…` P2SH address. A legacy `1…` address is
 * refused because it is also a BSV address, and coins sent to the wrong chain
 * are lost.
 */
export function btcOutputScript(address: string): Bytes {
  const trimmed = address.trim()
  if (/^bc1/i.test(trimmed)) {
    const decoded = decodeSegwitAddress(BTC_HRP, trimmed)
    if (!decoded) return fail('not a valid bc1 address')
    const { version, program } = decoded
    if (version > 1 || (version === 1 && program.length !== 32)) return fail(`segwit version ${version} is not paid by this wallet`)
    return concat(Uint8Array.of(version === 0 ? 0 : 0x51, program.length), program)
  }
  if (/^1/.test(trimmed)) return fail('a 1… address is also a BSV address; ask for a bc1 or 3… Bitcoin address')
  let parsed: { prefix: number[]; data: number[] }
  try {
    parsed = Utils.fromBase58Check(trimmed) as { prefix: number[]; data: number[] }
  } catch {
    return fail('not a valid Bitcoin address')
  }
  if (parsed.prefix.length !== 1 || parsed.prefix[0] !== P2SH_VERSION || parsed.data.length !== 20) return fail('not a Bitcoin mainnet address')
  return concat(Uint8Array.of(0xa9, 0x14), Uint8Array.from(parsed.data), Uint8Array.of(0x87))
}

// ── Proof of work ──────────────────────────────────────────────────────────

export const BTC_RETARGET_INTERVAL = 2016
const TARGET_TIMESPAN = 1_209_600
/** Mainnet `powLimit` (`0x1d00ffff`). */
export const BTC_POW_LIMIT = (1n << 224n) - 1n

/**
 * Bits of the first block of a retarget window. Bitcoin measures from the
 * window's first block (`firstTime`, height - 2016) to its last (`lastTime`),
 * one block short of the full window, exactly as Bitcoin Core does.
 */
export function nextBtcBits(lastBits: number, lastTime: number, firstTime: number): number {
  const span = Math.min(TARGET_TIMESPAN * 4, Math.max(Math.floor(TARGET_TIMESPAN / 4), lastTime - firstTime))
  const target = targetFromBits(lastBits)
  if (target === null) throw new Error('bad bits')
  const next = (target * BigInt(span)) / BigInt(TARGET_TIMESPAN)
  return compactFromTarget(next > BTC_POW_LIMIT ? BTC_POW_LIMIT : next)
}
