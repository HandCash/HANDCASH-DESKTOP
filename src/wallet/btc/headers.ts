import { storageRegistry } from '../../storage/registry'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, type HeaderRules, type LtcAnchor } from '../ltc/headers'
import { sha256dPowHash } from '../bch/bitcoincash'
import { BTC_POW_LIMIT, BTC_RETARGET_INTERVAL, nextBtcBits } from './bitcoin'
import { defaultBtcChain } from './chain'

/**
 * The wallet's own Bitcoin header chain. Bits change only at the first block
 * of each 2016-block window, from the times of that window's first and last
 * blocks; proof of work is double SHA-256.
 */
export const BTC_HEADER_RULES: HeaderRules = {
  label: 'Bitcoin',
  logTag: 'btc-headers',
  dbName: storageRegistry.btcHeaders.key,
  powLimit: BTC_POW_LIMIT,
  powHash: sha256dPowHash,
  expectedBits(height, prev, windowEnd) {
    if (height % BTC_RETARGET_INTERVAL !== 0) return prev.bits
    const last = prev.time ?? windowEnd(height - 1)
    const first = windowEnd(height - BTC_RETARGET_INTERVAL)
    return last === undefined || first === undefined ? null : nextBtcBits(prev.bits, last, first)
  },
  keepsTime: (height) => height % BTC_RETARGET_INTERVAL === 0 || height % BTC_RETARGET_INTERVAL === BTC_RETARGET_INTERVAL - 1,
}

/**
 * The block every install's Bitcoin chain starts from, read from two
 * independent servers (`npm run coin:checkpoint -- btc`), with the time of its
 * window's first block for the next retarget. It predates every Bitcoin coin
 * this wallet can hold.
 */
export const BTC_CHECKPOINT: LtcCheckpoint = {
  height: 971900,
  hash: '00000000000000000001ee88868d4fab432613abe3369ea14499455d613dd1c6',
  bits: 386007187,
  time: 1792266268,
  windowEnds: { 971712: 1792154251 },
}

/** Burial depth for a Bitcoin coin: three blocks, about half an hour, under the most work of any chain here. */
export const BTC_BURIAL_DEPTH = 3

let anchor: LtcAnchor | null = null

/** The wallet's Bitcoin header chain, made on first use. */
export function getBtcAnchor(): LtcAnchor {
  return (anchor ??= createHeaderChain({ rules: BTC_HEADER_RULES, source: defaultBtcChain(), checkpoint: BTC_CHECKPOINT }))
}

/** Tests swap the anchor; null restores the real chain. */
export function setBtcAnchorForTest(next: LtcAnchor | null): void {
  anchor = next
}
