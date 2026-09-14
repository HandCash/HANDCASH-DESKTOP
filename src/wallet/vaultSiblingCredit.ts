/**
 * Same-device vault transfers (BRC-146): credit a sibling account's local toolbox
 * when the payee identity is another account under the unlocked vault master.
 *
 * Mirrors selfReceive local-first internalization — do not wait on network sync
 * for the destination account to see the payment.
 *
 * Balance reads must touch ONLY the sibling toolbox. Never call session
 * `fetchBalanceRead` here — that credits the *active* wallet's unconfirmed
 * change and overwrites `lastKnownBalanceSats`.
 */
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { writeTrustedBalance } from './balanceSnapshot'
import { withVisibleOnChainBeef } from './legacyBeef'
import type { ActiveWallet } from './session'
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

/** txid-keyed so repeat credit / ingest never double-counts the same UTXO. */
const creditedTxids = new Set<string>()
const inflightCredits = new Map<string, Promise<VaultSiblingCreditResult>>()

function creditKey(accountIndex: number, txid: string): string {
  return `${accountIndex}:${txid.trim().toLowerCase()}`
}

async function readToolboxSpendableSats(wallet: {
  balance?: () => Promise<number>
  listOutputs?: (args: {
    basket: string
    limit: number
  }) => Promise<{ totalOutputs?: number; outputs?: Array<{ satoshis?: number }> }>
}): Promise<number | null> {
  if (typeof wallet.balance === 'function') {
    try {
      const sats = await wallet.balance()
      if (Number.isFinite(sats)) return Math.max(0, Math.trunc(sats))
    } catch {
      /* fall through */
    }
  }
  if (typeof wallet.listOutputs === 'function') {
    try {
      const result = await wallet.listOutputs({ basket: 'default', limit: 1000 })
      const rows = result.outputs ?? []
      if (rows.length > 0) {
        return rows.reduce((s, o) => s + (o.satoshis ?? 0), 0)
      }
      if (Number.isFinite(result.totalOutputs)) {
        return Math.max(0, Math.trunc(result.totalOutputs!))
      }
    } catch {
      /* fall through */
    }
  }
  return null
}

async function destroyTempSetup(setup: {
  monitor?: { stopTasks?: () => void }
  wallet?: { destroy?: () => Promise<void>; actionBatch?: { abort?: () => Promise<boolean> } }
  storage?: { destroy?: () => Promise<void> }
  activeStorage?: { destroy?: () => Promise<void> }
}): Promise<void> {
  try {
    setup.monitor?.stopTasks?.()
  } catch {
    /* optional */
  }
  try {
    await setup.wallet?.actionBatch?.abort?.()
  } catch {
    /* optional — clear reserved batches on the temp session */
  }
  try {
    await setup.wallet?.destroy?.()
  } catch {
    /* optional */
  }
  try {
    await setup.storage?.destroy?.()
  } catch {
    /* optional */
  }
  try {
    await setup.activeStorage?.destroy?.()
  } catch {
    /* optional */
  }
}

/**
 * Open the destination account toolbox (separate IDB), internalize the BRC-29
 * payment, persist trusted balance for that identity, and destroy the temp session.
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
  // Disabled: v1.3.146 sibling credit + abortReserved on the sender doubled
  // balances and hung sends. Root→child uses normal peer notify / chain ingest.
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


async function creditVaultSiblingBrc29PaymentOnce(
  args: {
    active: ActiveWallet
    account: VaultAccount
    txid: string
    remittance: Brc29Remittance
    senderIdentityKey: string
    atomicBeef: number[]
    satoshis: number
  },
  key: string,
): Promise<VaultSiblingCreditResult> {
  const { active, account } = args
  const txid = args.txid.trim().toLowerCase()

  if (creditedTxids.has(key)) {
    return {
      accepted: true,
      balanceSats: null,
      accountIndex: account.index,
      identityKey: account.identityKey,
      reason: 'already-credited',
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

  const rootKeyHex = rootKeyHexForAccount(
    active.masterRootKeyHex!,
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
      /* optional — never leave monitor racing the active wallet */
    }

    const {
      alreadyInternalizedError,
      withRestoredInternalizeStatus,
    } = await import('./peerIngestHelpers')

    let internalized = false
    try {
      await withRestoredInternalizeStatus(txid, () =>
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
      internalized = true
    } catch (err) {
      if (!alreadyInternalizedError(err)) throw err
      // Idempotent: toolbox already holds this outpoint — do not re-credit.
      internalized = true
    }

    // Sibling toolbox only — never active-wallet unconfirmed change.
    const balanceSats = await readToolboxSpendableSats(setup.wallet)
    if (balanceSats != null) {
      writeTrustedBalance(account.identityKey, chain, balanceSats)
    }

    if (internalized) {
      creditedTxids.add(key)
      // Bound receive activity to the *destination* account store only.
      try {
        const { bindAccountLocalKeyScope, peekAccountLocalKeyScope } =
          await import('./accountLocalKeys')
        const prev = peekAccountLocalKeyScope()
        bindAccountLocalKeyScope({
          accountIndex: account.index,
          identityKey: account.identityKey,
        })
        try {
          const { noteInboundReceiveComplete, rebindAppActivityForAccount } =
            await import('./appActivity')
          const sats =
            typeof args.satoshis === 'number' && args.satoshis > 0
              ? Math.floor(args.satoshis)
              : 0
          if (sats > 0) {
            noteInboundReceiveComplete({ txid, sats })
          }
          // Restore sender scope and reload its activity cache (listeners
          // may have briefly seen the sibling store during the write).
          bindAccountLocalKeyScope({
            accountIndex: prev.accountIndex,
            identityKey: prev.identityKey ?? active.identityKey,
          })
          rebindAppActivityForAccount()
        } catch {
          bindAccountLocalKeyScope({
            accountIndex: prev.accountIndex,
            identityKey: prev.identityKey ?? active.identityKey,
          })
        }
      } catch (err) {
        console.warn(
          '[vault-sibling] activity record skipped',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    console.info(
      `[vault-sibling] credited account ${account.index} tx=${txid.slice(0, 12)}… balance=${balanceSats ?? 'n/a'}`,
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
    await destroyTempSetup(setup)
  }
}

/** Test helper — drop in-memory credit gates. */
export function resetVaultSiblingCreditForTests(): void {
  creditedTxids.clear()
  inflightCredits.clear()
}
