/** Render harness: the claimed handle comes from the fixture, not the cloud claim store. */
import type { ClaimedHandleState } from '../../../../src/wallet/handleClaim'
import { mockState } from '../../mockState'

export * from '../../../../src/wallet/handleClaim'

export function claimedHandleForIdentity(identityKey: string | null | undefined): ClaimedHandleState | null {
  const { claimed } = mockState()
  return claimed && identityKey ? claimed : null
}

export function subscribeClaimedCloudHandle(_listener: () => void): () => void {
  return () => {}
}
