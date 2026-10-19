import { PrivateKey } from '@bsv/sdk'
import { agreedTerms, settleKeyOf, swapLegs, type AgreedTerms, type SwapLegId, type SwapRole, type SwapTerms } from './settle'
import { activeSwaps, type SettleRecord } from './settleStore'
import type { ActiveWallet } from '../session'

/** What every part of the swap runner shares: its log, the record's two legs and keys, and whether a leg can be locked. */

export const log = (swapId: string, text: string) => console.info(`[swap-settle] ${swapId.slice(0, 8)} ${text}`)
export const warn = (swapId: string, text: string) => console.warn(`[swap-settle] ${swapId.slice(0, 8)} ${text}`)
export const rootOf = (active: ActiveWallet) => PrivateKey.fromHex(active.rootKeyHex)
export const ownLegId = (r: SettleRecord): SwapLegId => r.role
export const peerLegId = (r: SettleRecord): SwapLegId => (r.role === 'taker' ? 'maker' : 'taker')
export const agreedOf = (r: SettleRecord): AgreedTerms | null => agreedTerms(r.terms, r.makerPub)
export const keyOf = (active: ActiveWallet, r: SettleRecord) => settleKeyOf(rootOf(active), r.terms, r.role)
export const recipeTerms = (r: SettleRecord) => JSON.stringify(agreedOf(r))

/** Whether this wallet can lock its leg of `terms` beside every swap it has promised and not yet locked. BSV reads the live balance: a cached one accepted a take the wallet could not fund. */
export async function canLock(role: SwapRole, terms: SwapTerms): Promise<string | null> {
  const leg = swapLegs(terms)[role]
  const promised = activeSwaps()
    .filter((r) => r.terms.swapId !== terms.swapId && !r.own.funding && !r.outcome && swapLegs(r.terms)[r.role].chain === leg.chain)
    .reduce((sum, r) => sum + swapLegs(r.terms)[r.role].amount + swapLegs(r.terms)[r.role].fee, 0n)
  const units = leg.amount + leg.fee + promised
  try {
    if (leg.chain === 'bsv') {
      const { assertSendableBalanceForReview } = await import('../sendPayment')
      await assertSendableBalanceForReview(Number(units), { fresh: true })
      return null
    }
    const { coinWalletOf } = await import('../coinMethods')
    const spendable = BigInt((await coinWalletOf(leg.chain)).readBalance().spendable)
    return spendable >= units ? null : 'insufficient'
  } catch {
    return 'insufficient'
  }
}
