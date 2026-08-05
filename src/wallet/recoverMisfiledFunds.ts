/**
 * Return funds misfiled into item baskets back to spendable change.
 *
 * Baskets `1sat` / `1sat-latch` hold collectables, and balance is summed from
 * basket `default` only. An output worth more than a satoshi in an item basket
 * is therefore money the user cannot see or spend. Historically the legacy
 * migration trusted the cloud item list without checking the live UTXO value,
 * so real funding outputs could land there.
 *
 * Recovery spends them with no explicit outputs, so the whole amount (less fee)
 * returns to change.
 */
import { Beef, P2PKH, PrivateKey, Transaction, type SignableTransaction } from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import type { ActiveWallet } from './session'
import { getActiveWallet } from './session'
import { LATCH_DUST_SATS, ONE_SAT_LATCH_BASKET, isLatchDustSats } from './oneSatLatch'
import { resolveOneSatInscription } from './oneSatImport'

/** Item baskets that must never hold anything worth more than a satoshi. */
const ITEM_BASKETS = ['1sat', ONE_SAT_LATCH_BASKET] as const

/** Below this the fee outweighs what we would recover. */
const MIN_RECOVERABLE_SATS = 500

export type MisfiledOutput = {
  outpoint: string
  basket: string
  satoshis: number
  lockingScript?: string
}

export type SkipReason = 'foreign-key' | 'inscribed' | 'probe-failed'

export type SkippedOutput = {
  outpoint: string
  satoshis: number
  reason: SkipReason
}

export type RecoverMisfiledResult = {
  found: MisfiledOutput[]
  recoveredSats: number
  txid?: string
  skipped: SkippedOutput[]
  /** Recoverable sats left in place because the total was below the fee floor. */
  belowFloorSats: number
  /** Sweep attempted but failed — surfaced so the user is not left guessing. */
  error?: string
}

function normalizeOutpoint(outpoint: string): string {
  return outpoint.includes('_') ? outpoint.replace(/_(\d+)$/, '.$1') : outpoint
}

/** Item-basket outputs worth more than a satoshi — money that fell out of balance. */
export async function findMisfiledFunds(
  active?: ActiveWallet | null,
): Promise<MisfiledOutput[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return []

  const found: MisfiledOutput[] = []
  for (const basket of ITEM_BASKETS) {
    try {
      const result = await wallet.wallet.listOutputs({
        basket,
        limit: 1000,
        include: 'locking scripts',
        seekPermission: false,
      })
      for (const o of result.outputs ?? []) {
        const satoshis = o.satoshis ?? 0
        // Soft-latch dust is intentional (2 sats) — leave it in the latch basket.
        if (satoshis <= LATCH_DUST_SATS) continue
        if (isLatchDustSats(satoshis)) continue
        found.push({
          outpoint: normalizeOutpoint(o.outpoint),
          basket,
          satoshis,
          lockingScript: o.lockingScript,
        })
      }
    } catch (err) {
      console.warn(`[recover] listOutputs ${basket} failed`, err)
    }
  }
  return found
}

/**
 * Sweep misfiled item-basket funds back into spendable change.
 * Outputs locked to a key this device cannot sign are reported, not swept.
 */
export async function recoverMisfiledFunds(
  active?: ActiveWallet | null,
): Promise<RecoverMisfiledResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const found = await findMisfiledFunds(wallet)
  if (found.length === 0) {
    return { found, recoveredSats: 0, skipped: [], belowFloorSats: 0 }
  }

  const expectedLock = new P2PKH().lock(wallet.address).toHex().toLowerCase()
  const skipped: SkippedOutput[] = []
  const spendable: MisfiledOutput[] = []
  for (const o of found) {
    if (o.lockingScript && o.lockingScript.toLowerCase() !== expectedLock) {
      skipped.push({ outpoint: o.outpoint, satoshis: o.satoshis, reason: 'foreign-key' })
      continue
    }
    // Inscriptions on larger outputs exist. Sweeping one would destroy it, which
    // is far worse than leaving the sats out of balance — when in doubt, keep it.
    // Only this outpoint counts: the ancestor walk resolveOneSatInscription does
    // by default reports funding outputs descended from an ordinal spend as
    // inscribed, which held real money in the basket forever.
    const [txid, vout] = o.outpoint.split('.')
    let inscribed = false
    try {
      inscribed = (await resolveOneSatInscription(txid!, Number(vout), wallet.chain, 0)) != null
    } catch (err) {
      console.warn('[recover] inscription probe failed — keeping output', o.outpoint, err)
      skipped.push({ outpoint: o.outpoint, satoshis: o.satoshis, reason: 'probe-failed' })
      continue
    }
    if (inscribed) {
      skipped.push({ outpoint: o.outpoint, satoshis: o.satoshis, reason: 'inscribed' })
      continue
    }
    spendable.push(o)
  }

  const recoverableSats = spendable.reduce((s, o) => s + o.satoshis, 0)
  if (spendable.length === 0) {
    return { found, recoveredSats: 0, skipped, belowFloorSats: 0 }
  }
  if (recoverableSats < MIN_RECOVERABLE_SATS) {
    return { found, recoveredSats: 0, skipped, belowFloorSats: recoverableSats }
  }

  try {
    const result = await wallet.wallet.createAction({
      description: 'Recover misfiled funds',
      labels: ['recover-misfiled'],
      inputs: spendable.map((o) => ({
        outpoint: o.outpoint,
        inputDescription: `Misfiled ${o.basket} funds`,
        unlockingScriptLength: 108,
      })),
      outputs: [],
      options: {
        trustSelf: 'known',
        acceptDelayedBroadcast: false,
        signAndProcess: true,
      },
    })

    let txid = result.txid
    if (!txid) {
      const signable = result.signableTransaction
      if (!signable) throw new Error('Recovery completed without txid')
      txid = await signWithRootKey(wallet, signable, spendable.map((o) => o.outpoint))
    }

    return { found, recoveredSats: recoverableSats, txid, skipped, belowFloorSats: 0 }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn('[recover] sweep failed', err)
    return { found, recoveredSats: 0, skipped, belowFloorSats: 0, error }
  }
}

async function signWithRootKey(
  wallet: ActiveWallet,
  signable: SignableTransaction,
  outpoints: string[],
): Promise<string> {
  const targets = new Set(
    outpoints.map((op) => {
      const [txid, vout] = normalizeOutpoint(op).split('.')
      return `${txid?.toLowerCase()}.${Number(vout)}`
    }),
  )

  const beef = Beef.fromBinary(signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${input?.sourceOutputIndex}`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('Misfiled input missing from the signable transaction')
  }

  const rootKey = PrivateKey.fromHex(wallet.rootKeyHex)
  for (const vin of vins) {
    unsigned.inputs[vin]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(rootKey, 1)
  }
  await unsigned.sign()

  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign the recovery transaction')
    spends[vin] = { unlockingScript }
  }

  const signed = await wallet.wallet.signAction({ reference: signable.reference, spends })
  if (!signed.txid) throw new Error('Recovery returned no txid')
  return signed.txid
}
