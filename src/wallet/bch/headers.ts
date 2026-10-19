import { storageRegistry } from '../../storage/registry'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, type HeaderRules, type LtcAnchor } from '../ltc/headers'
import { BCH_POW_LIMIT, nextBchBits, sha256dPowHash } from './bitcoincash'
import { defaultBchChain } from './chain'

/**
 * The wallet's own Bitcoin Cash header chain. Every block's bits follow from
 * its parent's time alone (ASERT), so no retarget window is kept; proof of
 * work is double SHA-256.
 */
export const BCH_HEADER_RULES: HeaderRules = {
  label: 'Bitcoin Cash',
  logTag: 'bch-headers',
  dbName: storageRegistry.bchHeaders.key,
  powLimit: BCH_POW_LIMIT,
  powHash: sha256dPowHash,
  expectedBits: (height, prev) => (prev.time === undefined ? null : nextBchBits(height, prev.time)),
  keepsTime: () => false,
}

/**
 * The block every install's Bitcoin Cash chain starts from, read from two
 * independent Fulcrum servers. It predates every Bitcoin Cash coin this
 * wallet can hold; moving it up would strand older coins beyond the link-down
 * cap in `ltc/headers.ts`.
 */
export const BCH_CHECKPOINT: LtcCheckpoint = {
  height: 973400,
  hash: '0000000000000000006af817616bd38c6b34f7827708300cdd5c2c97035e39e4',
  bits: 402807299,
  time: 1792319314,
  windowEnds: {},
}

/** Burial depth for a Bitcoin Cash coin: six blocks, as for Litecoin. */
export const BCH_BURIAL_DEPTH = 6

let anchor: LtcAnchor | null = null

/** The wallet's Bitcoin Cash header chain, made on first use. */
export function getBchAnchor(): LtcAnchor {
  return (anchor ??= createHeaderChain({ rules: BCH_HEADER_RULES, source: defaultBchChain(), checkpoint: BCH_CHECKPOINT }))
}

/** Tests swap the anchor; null restores the real chain. */
export function setBchAnchorForTest(next: LtcAnchor | null): void {
  anchor = next
}
