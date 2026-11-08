/** Render harness: public identity rows come from the fixture, not account storage. */
import type { WalletRuntime } from '../../../../src/wallet/walletRuntime'
import type { PublicIdentityRow } from '../../../../src/wallet/publicIdentities'
import { mockState } from '../../mockState'

export * from '../../../../src/wallet/publicIdentities'

export function listPublicIdentities(_runtime: WalletRuntime | null): PublicIdentityRow[] {
  return mockState().identities
}

export function selectedPublicIdentityKey(_runtime: WalletRuntime | null): string {
  const state = mockState()
  return state.selectedIdentityKey ?? state.profile.identityKey
}

export function presentedPublicIdentityKey(_runtime: WalletRuntime | null): string | null {
  return mockState().presentedIdentityKey
}

export function signsIssuance(_runtime: WalletRuntime | null): boolean {
  return mockState().signsIssuance
}
