/**
 * Wallet createAction bridge for hardened BRC-156 alternating Commit/Settle.
 *
 * The clean-room scrypt-ts covenant (BOLT-style delayed proofs) is implemented
 * and covered by `oneSatHardenedLatch.test.ts`. Soft-latch remains the live
 * send path until this bridge maps wallet-toolbox signable transactions into
 * alternating `commit` / `settle` / `settleProof` unlocking scripts.
 *
 * Callers must not reach here while {@link isHardenedSendEnabled} is false.
 */
import { isHardenedSendEnabled } from './oneSatHardenedLatch'
import type { ActiveWallet } from './session'

export type HardenedSendArgs = {
  wallet: ActiveWallet
  outpoint: string
  recipientIdentityKey: string
  toAddress: string
  origin: string
  name: string
  app?: string
  mimeType?: string
  tipLockingScript?: string
  tipCustomInstructions?: string
  priorProofOutpoint?: string | null
  priorProofLockingScript?: string
  originLockingScriptHex?: string
  legacyParentOutpoint?: string
  inputBEEF: number[]
  knownTxids: string[]
  buildInputBeefForSpends: (
    wallet: ActiveWallet,
    outpoints: string[],
  ) => Promise<number[]>
  normalizeOutpoint: (op: string) => string
  formatSendError: (err: unknown) => Error
  isAlreadySpentInputError: (err: unknown) => boolean
  releaseStaleSpendableOutputs: () => Promise<unknown>
}

export async function sendHardenedCollectable(
  _args: HardenedSendArgs,
): Promise<{ txid: string }> {
  if (!isHardenedSendEnabled()) {
    throw new Error(
      'Hardened BRC-156 alternating Commit/Settle is not enabled for wallet sends yet — use soft-latch / BRC-150',
    )
  }
  throw new Error('Hardened send bridge not implemented')
}
