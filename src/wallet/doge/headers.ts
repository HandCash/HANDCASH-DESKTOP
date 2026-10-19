import { storageRegistry } from '../../storage/registry'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, type HeaderRules, type LtcAnchor } from '../ltc/headers'
import { defaultDogeChain } from './chain'
import { DOGE_POW_LIMIT, dogePowHash, nextDogeBits, parseDogeHeader } from './dogecoin'

/**
 * The wallet's own Dogecoin header chain. Every block's bits follow from the
 * two blocks before it (DigiShield), so each block's time is kept until the
 * next two are taken. Work is checked through each header's AuxPoW.
 */
export const DOGE_HEADER_RULES: HeaderRules = {
  label: 'Dogecoin',
  logTag: 'doge-headers',
  dbName: storageRegistry.dogeHeaders.key,
  powLimit: DOGE_POW_LIMIT,
  powHash: dogePowHash,
  expectedBits(height, prev, windowEnd) {
    const before = windowEnd(height - 2)
    return prev.time === undefined || before === undefined ? null : nextDogeBits(prev.bits, prev.time, before)
  },
  keepsTime: () => true,
  parseHeader: parseDogeHeader,
}

/**
 * The block every install's Dogecoin chain starts from, read from two
 * independent servers (`npm run coin:checkpoint -- doge`), with its parent's
 * time for the first retarget. It predates every Dogecoin coin this wallet can
 * hold.
 */
export const DOGE_CHECKPOINT: LtcCheckpoint = {
  height: 6420500,
  hash: '4cd6012757a8598d422294770176588d01add8a4030909689dd6780860c36a9c',
  bits: 436246595,
  time: 1792338730,
  windowEnds: { 6420499: 1792338684 },
}

/** Burial depth for a Dogecoin coin: twenty one-minute blocks, merge-mined by Litecoin's hash power, so more work than Litecoin's six. */
export const DOGE_BURIAL_DEPTH = 20

let anchor: LtcAnchor | null = null

/** The wallet's Dogecoin header chain, made on first use. */
export function getDogeAnchor(): LtcAnchor {
  return (anchor ??= createHeaderChain({ rules: DOGE_HEADER_RULES, source: defaultDogeChain(), checkpoint: DOGE_CHECKPOINT }))
}

/** Tests swap the anchor; null restores the real chain. */
export function setDogeAnchorForTest(next: LtcAnchor | null): void {
  anchor = next
}
