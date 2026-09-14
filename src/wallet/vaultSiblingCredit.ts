/**
 * Same-device vault transfers (BRC-146) used to credit a sibling toolbox via a
 * temp SetupClient + internalizeAction. That path (v1.3.146) also aborted the
 * sender's reserved action batch and permanently doubled spendable balance.
 *
 * Hard-disabled: root→child uses normal peer notify / chain ingest.
 */
import type { ActiveWallet } from './session'
import type { VaultAccount } from './vaultAccounts'
import type { Brc29Remittance } from './sendBrc29Payment'

export type VaultSiblingCreditResult = {
  accepted: boolean
  balanceSats: number | null
  accountIndex: number
  identityKey: string
  reason?: string
}

export async function creditVaultSiblingBrc29Payment(args: {
  active: ActiveWallet
  account: VaultAccount
  txid: string
  remittance: Brc29Remittance
  senderIdentityKey: string
  atomicBeef: number[]
  satoshis: number
}): Promise<VaultSiblingCreditResult> {
  void args.active
  void args.txid
  void args.remittance
  void args.senderIdentityKey
  void args.atomicBeef
  void args.satoshis
  console.warn('[vault-sibling] credit disabled — use peer notify / chain ingest')
  return {
    accepted: false,
    balanceSats: null,
    accountIndex: args.account.index,
    identityKey: args.account.identityKey,
    reason: 'disabled',
  }
}

/** Test helper — no-op after disable. */
export function resetVaultSiblingCreditForTests(): void {}
