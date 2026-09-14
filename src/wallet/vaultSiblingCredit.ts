/**
 * Same-device vault transfers (BRC-146): credit a sibling account's local toolbox
 * when the payee identity is another account under the unlocked vault master.
 *
 * Mirrors selfReceive local-first internalization — do not wait on network sync
 * for the destination account to see the payment.
 */
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { writeTrustedBalance } from './balanceSnapshot'
import { withVisibleOnChainBeef } from './legacyBeef'
import { fetchBalanceRead, type ActiveWallet } from './session'
import type { Chain } from './vault'
import {
  rootKeyHexForAccount,
  toolboxDatabaseName,
  type VaultAccount,
} from './vaultAccounts'
import type { Brc29Remittance } from './sendBrc29Payment'

export type VaultSiblingCreditResult = {
  accepted: boolean
  balanceSats: number | null
  accountIndex: number
  identityKey: string
  reason?: string
}

/**
 * Open the destination account toolbox (separate IDB), internalize the BRC-29
 * payment, persist trusted balance for that identity, and close the temp session.
 * Does not change the active UI wallet.
 */
export async function creditVaultSiblingBrc29Payment(args: {
  active: ActiveWallet
  account: VaultAccount
  txid: string
  remittance: Brc29Remittance
  senderIdentityKey: string
  atomicBeef: number[]
  satoshis: number
}): Promise<VaultSiblingCreditResult> {
  const { active, account } = args
  if (account.index === active.accountIndex) {
    return {
      accepted: false,
      balanceSats: null,
      accountIndex: account.index,
      identityKey: account.identityKey,
      reason: 'same-account',
    }
  }
  if (!active.masterRootKeyHex) {
    return {
      accepted: false,
      balanceSats: null,
      accountIndex: account.index,
      identityKey: account.identityKey,
      reason: 'no-master',
    }
  }

  const prefix = args.remittance.derivationPrefix?.trim()
  const suffix = args.remittance.derivationSuffix?.trim()
  if (!prefix || !suffix) {
    return {
      accepted: false,
      balanceSats: null,
      accountIndex: account.index,
      identityKey: account.identityKey,
      reason: 'missing-remittance',
    }
  }

  const outputIndexRaw = args.remittance.outputIndex
  const outputIndex =
    typeof outputIndexRaw === 'number' &&
    Number.isInteger(outputIndexRaw) &&
    outputIndexRaw >= 0
      ? outputIndexRaw
      : 0

  const rootKeyHex = rootKeyHexForAccount(
    active.masterRootKeyHex,
    account.index,
  )
  const chain: Chain = active.chain
  const setup = await SetupClient.createWalletIdb({
    chain,
    rootKeyHex,
    databaseName: toolboxDatabaseName({
      chain,
      handle: active.handle,
      accountIndex: account.index,
    }),
  })
  try {
    try {
      setup.monitor?.stopTasks?.()
    } catch {
      /* optional */
    }

    const atomic = args.atomicBeef
    if (!atomic.length) {
      return {
        accepted: false,
        balanceSats: null,
        accountIndex: account.index,
        identityKey: account.identityKey,
        reason: 'missing-beef',
      }
    }

    const { withRestoredInternalizeStatus } = await import('./peerIngestHelpers')
    await withRestoredInternalizeStatus(args.txid, () =>
      withVisibleOnChainBeef(() =>
        setup.wallet.internalizeAction({
          tx: atomic,
          description: 'BRC-29 vault transfer received',
          labels: ['brc29', 'vault-sibling'],
          outputs: [
            {
              outputIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: prefix,
                derivationSuffix: suffix,
                senderIdentityKey: args.senderIdentityKey,
              },
            },
          ],
          seekPermission: false,
        }),
      ),
    )

    // Read this toolbox only — never fall back to the active account's
    // lastKnownBalanceSats (session.fetchBalanceSats does that on error).
    const read = await fetchBalanceRead(setup.wallet)
    const balanceSats = read.kind === 'ok' ? read.sats : null
    if (balanceSats != null) {
      writeTrustedBalance(account.identityKey, chain, balanceSats)
    }
    console.info(
      `[vault-sibling] credited account ${account.index} tx=${args.txid.slice(0, 12)}… balance=${balanceSats ?? 'n/a'}`,
    )
    return {
      accepted: true,
      balanceSats,
      accountIndex: account.index,
      identityKey: account.identityKey,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[vault-sibling] credit failed', account.index, msg)
    return {
      accepted: false,
      balanceSats: null,
      accountIndex: account.index,
      identityKey: account.identityKey,
      reason: msg,
    }
  } finally {
    try {
      setup.monitor?.stopTasks?.()
    } catch {
      /* optional */
    }
  }
}
