/**
 * Draft BRC-249, "Moving on demand": an account that moved here merges the
 * history its previous holder flushed before anything spends it.
 */
import { recomposeWallet } from './recompose'

export async function mergeArrivedForSpend(): Promise<void> {
  const result = await recomposeWallet({ reason: 'account-arrived', history: 'mergeArrived' })
  if (result.history === 'failed') {
    throw new Error(
      'This wallet moved here but its history could not be loaded, so it was not spent. Check the connection and try again.',
    )
  }
}
