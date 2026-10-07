/**
 * Sweep a visible P2PKH deposit into BRC-100 change.
 *
 * Cash receive: the UTXO is already on the network (mempool or a block). We do
 * not walk merkle ancestry. After signing we post the deposit body plus the
 * sweep to ARC — a local-only sweep is not a receive.
 */
import { Beef, PrivateKey, type BEEF, type WalletInterface } from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'

import { withVisibleOnChainBeef } from './legacyBeef'
import type { ActiveWallet } from './session'

export type P2pkhSweepResult = {
  outpoint: string
  txid?: string
  success: boolean
  error?: string
}

function asBytes(tx: unknown): number[] {
  if (Array.isArray(tx) && tx.every((n) => typeof n === 'number')) return tx as number[]
  if (tx instanceof Uint8Array) return Array.from(tx)
  return []
}

function packSweepAtomic(depositBeef: BEEF, signedAtomic: number[], sweepTxid: string): number[] {
  const packed = new Beef()
  packed.mergeBeef(depositBeef)
  packed.mergeBeef(signedAtomic)
  packed.atomicTxid = undefined
  return packed.toBinaryAtomic(sweepTxid)
}

async function postSweep(
  _wallet: ActiveWallet,
  txid: string,
  atomic: number[],
): Promise<{ ok: boolean; detail: string }> {
  const { submitAtomicBeefToMiners } = await import('./minerSubmit')
  const result = await submitAtomicBeefToMiners(txid, atomic)
  return {
    ok: result.kind !== 'unproven-conflict',
    detail: result.summary?.detail ?? result.kind,
  }
}

/** One coin to sweep, resolved against the deposit package. */
type SweepCoin = { outpoint: string; txid: string; vout: number; satoshis: number }

/**
 * Who signs each coin: one key for all of them, or a key per outpoint
 * (`txid.vout`, lowercase) so coins at many addresses share transactions.
 */
export type SweepSpendKeys = string | ReadonlyMap<string, string>

/**
 * Coins per sweep transaction. A P2PKH input is ~148 bytes, so a full bundle
 * is ~15 KB and pays for itself many times over versus one fee per coin.
 */
export const MAX_P2PKH_SWEEP_INPUTS = 100

export type P2pkhSweepUnit =
  | { kind: 'bundle'; coins: SweepCoin[] }
  | { kind: 'single'; coin: SweepCoin }

/** The next transaction: every waiting coin up to `perTx`, or one alone. Pure. */
export function chooseP2pkhSweepUnit(coins: readonly SweepCoin[], perTx = MAX_P2PKH_SWEEP_INPUTS): P2pkhSweepUnit {
  const cap = Math.max(1, Math.min(Math.floor(perTx), MAX_P2PKH_SWEEP_INPUTS))
  if (coins.length === 1 || cap === 1) return { kind: 'single', coin: coins[0]! }
  return { kind: 'bundle', coins: coins.slice(0, cap) }
}

function resolveCoin(depositBeef: Beef, outpoint: string): SweepCoin {
  const [txidPart, voutPart] = outpoint.split('.')
  const txid = (txidPart ?? '').toLowerCase()
  const vout = Number(voutPart)
  const btx = depositBeef.findTxid(txid)
  if (btx?.tx == null) throw new Error(`Transaction ${txid} not found in inputBEEF`)
  const output = btx.tx.outputs[vout]
  if (!output) throw new Error(`vout ${vout} out of range`)
  const satoshis = Number(output.satoshis ?? 0)
  if (!(satoshis > 0)) throw new Error(`Output ${outpoint} has no satoshis`)
  return { outpoint, txid, vout, satoshis }
}

async function signAndComplete(
  wallet: WalletInterface,
  st: { tx: number[]; reference: string },
  coins: readonly SweepCoin[],
  keyOf: (coin: SweepCoin) => PrivateKey,
): Promise<{ txid: string; tx: number[] }> {
  const stBeef = Beef.fromBinary(st.tx)
  const wanted = new Map(coins.map((c) => [`${c.txid}.${c.vout}`, c]))
  const unsignedTx = stBeef.txs
    .map((btx) => btx.tx)
    .find((tx) => tx?.inputs.some((inp) => wanted.has(`${String(inp.sourceTXID).toLowerCase()}.${inp.sourceOutputIndex}`)))
  if (unsignedTx == null) throw new Error('Could not find requested outpoints in signable transaction inputs')
  const ours: number[] = []
  unsignedTx.inputs.forEach((inp, i) => {
    const coin = wanted.get(`${String(inp.sourceTXID).toLowerCase()}.${inp.sourceOutputIndex}`)
    if (!coin) return
    inp.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(keyOf(coin), coin.satoshis)
    ours.push(i)
  })
  if (ours.length !== coins.length) throw new Error('Signable transaction is missing requested outpoints')
  await unsignedTx.sign()
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const i of ours) spends[i] = { unlockingScript: unsignedTx.inputs[i]!.unlockingScript!.toHex() }
  const sar = await wallet.signAction({ reference: st.reference, spends })
  const txid = sar.txid?.toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('signAction returned no valid txid')
  const tx = asBytes(sar.tx)
  if (tx.length === 0) throw new Error('signAction returned no transaction body')
  return { txid, tx }
}

/** Sweep `coins` in one transaction; throws when it is not accepted. */
async function sweepCoins(
  active: ActiveWallet,
  depositBin: BEEF,
  coins: readonly SweepCoin[],
  keyOf: (coin: SweepCoin) => PrivateKey,
): Promise<{ txid: string }> {
  const first = coins[0]!
  const car = await active.wallet.createAction({
    inputBEEF: depositBin,
    inputs: coins.map((coin) => ({
      outpoint: coin.outpoint,
      unlockingScriptLength: 108,
      inputDescription: 'fund wallet from P2PKH',
    })),
    labels: ['p2pkh-funding'],
    description:
      coins.length === 1
        ? `Import P2PKH UTXO ${first.txid.slice(0, 16)}...`
        : `Import ${coins.length} P2PKH UTXOs`,
    options: { trustSelf: 'known', signAndProcess: false },
  })

  let sweepTxid = (car.txid ?? '').toLowerCase()
  let sweepAtomic = asBytes(car.tx)
  if (car.signableTransaction) {
    const reference = car.signableTransaction.reference
    let signed: { txid: string; tx: number[] }
    try {
      signed = await signAndComplete(
        active.wallet,
        { tx: asBytes(car.signableTransaction.tx), reference },
        coins,
        keyOf,
      )
    } catch (err) {
      // Nothing was signed: free whatever the unsigned action reserved.
      await active.wallet.abortAction({ reference }).catch(() => undefined)
      throw err
    }
    sweepTxid = signed.txid
    sweepAtomic = signed.tx
  }
  if (!/^[0-9a-f]{64}$/.test(sweepTxid) || sweepAtomic.length === 0) {
    throw new Error('sweep produced no broadcastable transaction')
  }

  const atomic = packSweepAtomic(depositBin, sweepAtomic, sweepTxid)
  const posted = await postSweep(active, sweepTxid, atomic)
  if (!posted.ok) {
    throw new Error(`sweep not accepted by the network (${posted.detail})`)
  }
  return { txid: sweepTxid }
}

async function echoSweepChange(active: ActiveWallet, sweepTxid: string): Promise<void> {
  try {
    const { rememberDerivedChangeFromTxid } = await import('./derivedChangeEcho')
    await rememberDerivedChangeFromTxid(sweepTxid, active)
  } catch (err) {
    console.warn('[legacy] derived-change echo skipped', sweepTxid.slice(0, 12), err)
  }
}

/**
 * Sweep visible P2PKH coins, as many to a transaction as {@link MAX_P2PKH_SWEEP_INPUTS}.
 *
 * A rejection does not say which coin was at fault, so a rejected bundle is
 * halved and retried down to single coins: one bad coin costs a few attempts,
 * never the rest of the sweep, and every failure is pinned to its own coin.
 */
export async function sweepVisibleP2pkhOutpoints(
  wallet: ActiveWallet,
  outpoints: string[],
  inputBeef: BEEF,
  /** Who signs the P2PKH tips — defaults to this wallet's root. */
  spendKeys?: SweepSpendKeys,
): Promise<P2pkhSweepResult[]> {
  const keys = new Map<string, PrivateKey>()
  const keyHexOf = (outpoint: string): string | undefined =>
    typeof spendKeys === 'string' || spendKeys == null
      ? (spendKeys ?? wallet.rootKeyHex)
      : spendKeys.get(outpoint.trim().toLowerCase())
  const keyOf = (coin: SweepCoin): PrivateKey => {
    const hex = keyHexOf(coin.outpoint)!.trim()
    let key = keys.get(hex)
    if (!key) keys.set(hex, (key = PrivateKey.fromHex(hex)))
    return key
  }
  const depositBeef = Beef.fromBinary(inputBeef)
  return withVisibleOnChainBeef(async () => {
    const startedAt = Date.now()
    const results: P2pkhSweepResult[] = []
    const coins: SweepCoin[] = []
    for (const outpoint of outpoints) {
      try {
        if (!keyHexOf(outpoint)) throw new Error('no key holds this coin')
        coins.push(resolveCoin(depositBeef, outpoint))
      } catch (err) {
        results.push({ outpoint, success: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    let pending = coins
    let perTx = MAX_P2PKH_SWEEP_INPUTS
    let transactions = 0
    while (pending.length > 0) {
      const unit = chooseP2pkhSweepUnit(pending, perTx)
      const group = unit.kind === 'bundle' ? unit.coins : [unit.coin]
      try {
        const { txid } = await sweepCoins(wallet, inputBeef, group, keyOf)
        await echoSweepChange(wallet, txid)
        for (const coin of group) results.push({ outpoint: coin.outpoint, txid, success: true })
        transactions += 1
        console.info(`[legacy] sweep ${group.length} coin(s) txid=${txid.slice(0, 12)}… posted`)
        pending = pending.slice(group.length)
        perTx = MAX_P2PKH_SWEEP_INPUTS
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (unit.kind === 'bundle') {
          perTx = Math.max(1, Math.ceil(group.length / 2))
          console.warn(`[legacy] sweep bundle of ${group.length} refused — retrying ${perTx} (${error})`)
          continue
        }
        results.push({ outpoint: unit.coin.outpoint, success: false, error })
        console.warn(`[legacy] sweep ${unit.coin.outpoint} failed`, error)
        pending = pending.slice(1)
        perTx = MAX_P2PKH_SWEEP_INPUTS
      }
    }
    const ms = Date.now() - startedAt
    if (ms >= 250 || coins.length > 1) {
      console.info(`[legacy] sweep coins=${coins.length} tx=${transactions} done ${ms}ms`)
    }
    return results
  })
}
