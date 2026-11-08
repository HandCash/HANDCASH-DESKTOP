/** Render harness: BAP maintenance (overlay sync, proof upgrades) never runs. */
import type { WalletRuntime } from '../../../../src/wallet/walletRuntime'

export * from '../../../../src/wallet/identityPublish'

export async function syncHeldIssuerIdentities(_runtime: WalletRuntime | null, _onlyKey?: string): Promise<number> {
  return 0
}

export async function upgradeIssuerIdentityProofs(_runtime: WalletRuntime): Promise<number> {
  return 0
}
