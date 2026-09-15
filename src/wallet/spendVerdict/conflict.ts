import type { Chain } from '../vault'

export type SpendConflictIntent = 'postBeefGhostCheck' | 'arcadePinRemoval'

/**
 * Dispatch to the correct on-chain conflict helper without merging them.
 *
 * - `postBeefGhostCheck` → {@link postBeefConflictIsReal}: our tx on-chain
 *   *is* a real conflict (the send landed despite Arcade noise).
 * - `arcadePinRemoval` → {@link signedTxSpendConflictIsProven}: our tx
 *   on-chain means the pin holds; proven conflict is competing spend of inputs.
 */
export async function spendConflictIsProven(args: {
  intent: SpendConflictIntent
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  if (args.intent === 'arcadePinRemoval') {
    const { signedTxSpendConflictIsProven } = await import('../arcadeSubmitGuard')
    return signedTxSpendConflictIsProven({
      txid: args.txid,
      atomic: args.atomic,
      chain: args.chain,
    })
  }
  const { postBeefConflictIsReal } = await import('../postBeefResult')
  return postBeefConflictIsReal({
    txid: args.txid,
    atomic: args.atomic,
    chain: args.chain,
  })
}
