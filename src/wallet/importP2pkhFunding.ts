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
import { summarizePostBeef } from './postBeefResult'
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
  wallet: ActiveWallet,
  txid: string,
  atomic: number[],
): Promise<{ ok: boolean; detail: string }> {
  if (!wallet.services?.postBeef) {
    return { ok: false, detail: 'no postBeef service' }
  }
  const results = await wallet.services.postBeef(Beef.fromBinary(atomic), [txid])
  const summary = summarizePostBeef(results as never)
  return { ok: summary.accepted, detail: summary.detail }
}

async function signAndComplete(
  wallet: WalletInterface,
  st: { tx: number[]; reference: string },
  sourceTxid: string,
  vout: number,
  satoshis: number,
  priv: PrivateKey,
): Promise<{ txid: string; tx: number[] }> {
  const stBeef = Beef.fromBinary(st.tx)
  let unsignedTx
  let inputIndex = -1
  for (const stbtx of stBeef.txs) {
    if (stbtx.tx == null) continue
    for (let i = 0; i < stbtx.tx.inputs.length; i++) {
      const inp = stbtx.tx.inputs[i]
      if (String(inp.sourceTXID).toLowerCase() === sourceTxid && inp.sourceOutputIndex === vout) {
        unsignedTx = stbtx.tx
        inputIndex = i
        break
      }
    }
    if (unsignedTx != null) break
  }
  if (unsignedTx == null || inputIndex < 0) {
    throw new Error('Could not find requested outpoint in signable transaction inputs')
  }
  unsignedTx.inputs[inputIndex]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(priv, satoshis)
  await unsignedTx.sign()
  const unlockingScript = unsignedTx.inputs[inputIndex]!.unlockingScript!.toHex()
  const sar = await wallet.signAction({
    reference: st.reference,
    spends: { [inputIndex]: { unlockingScript } },
  })
  const txid = sar.txid?.toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('signAction returned no valid txid')
  const tx = asBytes(sar.tx)
  if (tx.length === 0) throw new Error('signAction returned no transaction body')
  return { txid, tx }
}

async function sweepOne(
  active: ActiveWallet,
  depositBeef: Beef,
  depositBin: BEEF,
  outpoint: string,
  p2pkhKey: ReturnType<typeof SetupClient.getKeyPair>,
): Promise<{ txid: string }> {
  const [txidPart, voutPart] = outpoint.split('.')
  const sourceTxid = (txidPart ?? '').toLowerCase()
  const vout = Number(voutPart)
  const btx = depositBeef.findTxid(sourceTxid)
  if (btx?.tx == null) throw new Error(`Transaction ${sourceTxid} not found in inputBEEF`)
  const output = btx.tx.outputs[vout]
  if (!output) throw new Error(`vout ${vout} out of range`)
  const satoshis = Number(output.satoshis ?? 0)
  if (!(satoshis > 0)) throw new Error(`Output ${outpoint} has no satoshis`)

  const car = await active.wallet.createAction({
    inputBEEF: depositBin,
    inputs: [
      { outpoint, unlockingScriptLength: 108, inputDescription: 'fund wallet from P2PKH' },
    ],
    labels: ['p2pkh-funding'],
    description: `Import P2PKH UTXO ${sourceTxid.slice(0, 16)}...`,
    options: { trustSelf: 'known', signAndProcess: false },
  })

  let sweepTxid = (car.txid ?? '').toLowerCase()
  let sweepAtomic = asBytes(car.tx)
  if (car.signableTransaction) {
    const signed = await signAndComplete(
      active.wallet,
      {
        tx: asBytes(car.signableTransaction.tx),
        reference: car.signableTransaction.reference,
      },
      sourceTxid,
      vout,
      satoshis,
      p2pkhKey.privateKey,
    )
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

export async function sweepVisibleP2pkhOutpoints(
  wallet: ActiveWallet,
  outpoints: string[],
  inputBeef: BEEF,
  /** Spend key for the P2PKH tips — defaults to this wallet's root. */
  spendKeyHex?: string,
): Promise<P2pkhSweepResult[]> {
  const keyHex = (spendKeyHex ?? wallet.rootKeyHex).trim()
  const p2pkhKey = SetupClient.getKeyPair(PrivateKey.fromHex(keyHex))
  const depositBeef = Beef.fromBinary(inputBeef)
  return withVisibleOnChainBeef(async () => {
    const results: P2pkhSweepResult[] = []
    for (const outpoint of outpoints) {
      try {
        const { txid } = await sweepOne(wallet, depositBeef, inputBeef, outpoint, p2pkhKey)
        results.push({ outpoint, txid, success: true })
        console.info(`[legacy] sweep ${outpoint} txid=${txid.slice(0, 12)}… posted`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        results.push({ outpoint, success: false, error })
        console.warn(`[legacy] sweep ${outpoint} failed`, error)
      }
    }
    return results
  })
}
