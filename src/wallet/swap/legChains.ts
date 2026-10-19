import { P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { fromHex, ltcTxid, parseLtcTx, toHex, type Bytes, type LtcTx } from '../ltc/litecoin'
import type { LockSighting } from '../coins/coinWallet'
import type { SwapAsset } from './assets'
import { BSV_FEE_PER_BYTE, htlcSpendTx, htlcSignature, htlcSignatureValid, readSecret, signHtlcSpend, type HtlcCoin } from './htlc'
import type { LegScript } from './settle'

/**
 * What settlement needs from each chain a swap leg sits on: lock outputs,
 * prove a lock, see how it was spent, and spend one back into this wallet.
 * Coins of other chains go through the coin wallet (BRC-213), BSV through
 * the toolbox and the signed-send lifecycle. Nothing a source answers is
 * trusted: transactions are checked by hash, depth by this wallet's own
 * headers, and a secret by its hash.
 */

export type LegSpend =
  | { kind: 'unspent' }
  | { kind: 'claimed'; txid: string; secret: Bytes }
  | { kind: 'refunded'; txid: string }
  | { kind: 'unknown'; detail: string }

export type Outpoint = { txid: string; vout: number }

/** How a lock at `outpoint` was spent, judged from the spending transaction itself. */
export function judgeSpend(chain: SwapAsset, spender: LtcTx | null, outpoint: Outpoint, hash: Bytes): LegSpend {
  if (!spender) return { kind: 'unspent' }
  const vin = spender.inputs.findIndex((i) => i.txid === outpoint.txid && i.vout === outpoint.vout)
  if (vin < 0) return { kind: 'unknown', detail: 'the named spender does not spend the lock' }
  const secret = readSecret(chain, spender, vin, hash)
  const txid = ltcTxid(spender)
  return secret ? { kind: 'claimed', txid, secret } : { kind: 'refunded', txid }
}

/** A spend of a lock into this wallet, signed and ready; `commit` broadcasts it (and on BSV internalizes it). */
export type LockSpend = { txid: string; hex: string; value: bigint; commit(): Promise<void> }

export interface SwapLegChain {
  chain: SwapAsset
  /** Where a lock stands. On BSV `beef` is the Atomic BEEF the payer sent. */
  proveLock(outpoint: Outpoint, lock: LegScript, beef?: string): Promise<LockSighting>
  spendOf(outpoint: Outpoint, lock: LegScript, hash: Bytes): Promise<LegSpend>
  /** Sign a claim or refund of `coins` into this wallet. `value` fixes the output (a pre-signed BSV refund). */
  spendLock(args: {
    coins: HtlcCoin[]
    key: PrivateKey
    path: { kind: 'claim'; preimage: Bytes } | { kind: 'refund'; locktime: number; cosigs?: Bytes[] }
    /** BSV: where and how much the pre-signed refund pays. */
    fixed?: { to: Bytes; value: bigint; remittance: SelfRemittance }
    /** BSV: the lock transaction's Atomic BEEF, so the spend's own BEEF carries its source. */
    sourceBeef?: string
    label: string
  }): Promise<LockSpend>
}

// ── Coins of other chains ───────────────────────────────────────────────────

export async function coinLegChain(chain: Exclude<SwapAsset, 'bsv'>): Promise<SwapLegChain> {
  const { coinWalletOf } = await import('../coinMethods')
  const wallet = await coinWalletOf(chain)
  return {
    chain,
    proveLock: (outpoint, lock) => wallet.proveLock(outpoint, lock.scriptPubKey, lock.amount),
    async spendOf(outpoint, lock, hash) {
      if (!lock.address) return { kind: 'unknown', detail: 'a coin lock has an address' }
      try {
        return judgeSpend(chain, await wallet.spenderOf(outpoint, lock.address), outpoint, hash)
      } catch (err) {
        return { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) }
      }
    },
    async spendLock({ coins, key, path, label }) {
      const to = wallet.receiveScript()
      const signed = signHtlcSpend(chain, { coins, to: to.script, key, path, feeRate: await wallet.feeRate() })
      return {
        txid: signed.txid,
        hex: signed.hex,
        value: signed.tx.outputs[0]!.value,
        async commit() {
          const sent = await wallet.broadcastRaw(signed.hex, signed.txid)
          console.info(`[swap-settle] ${chain} ${label} ${signed.txid.slice(0, 12)} ${sent}`)
        },
      }
    },
  }
}

// ── BSV ─────────────────────────────────────────────────────────────────────

/** A BRC-29 child of this wallet's own identity: what a BSV claim or refund pays, internalized in place. */
export type SelfRemittance = { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }

const b64 = (bytes: number[] | Uint8Array) => Utils.toBase64(Array.from(bytes))
const unb64 = (text: string) => Utils.toArray(text, 'base64')

/** The lock transaction an Atomic BEEF carries, refused unless it is `txid`. */
export function bsvLockTx(beef: string, txid: string): Transaction {
  const tx = Transaction.fromAtomicBEEF(unb64(beef))
  if (tx.id('hex') !== txid) throw new Error('the lock BEEF is for another transaction')
  return tx
}

/** A fresh self-payment output for a BSV claim or refund. */
export async function bsvSelfOutput(): Promise<{ to: Bytes; remittance: SelfRemittance }> {
  const { requireActiveWallet } = await import('./settlePorts')
  const { selfBrc29Output } = await import('../brc29Keys')
  const out = selfBrc29Output(requireActiveWallet())
  return { to: Uint8Array.from(new P2PKH().lock(out.address).toBinary()), remittance: out.remittance }
}

/** An unsigned BSV refund of `coin` to `to`: what the counterparty co-signs before the lock is broadcast. */
export function bsvRefundTx(coin: HtlcCoin, to: Bytes, value: bigint, locktime: number): LtcTx {
  return htlcSpendTx('bsv', [coin], to, value, 'refund', locktime)
}

/** The counterparty's co-signature over a BSV refund of `coin`. */
export function cosignBsvRefund(coin: HtlcCoin, to: Bytes, value: bigint, locktime: number, key: PrivateKey): string {
  if (value <= 0n || value > coin.amount) throw new Error('a refund pays out of its lock')
  return toHex(htlcSignature('bsv', bsvRefundTx(coin, to, value, locktime), 0, coin.script, coin.amount, key))
}

export function bsvCosignValid(coin: HtlcCoin, to: Bytes, value: bigint, locktime: number, cosignPub: Bytes, cosig: string): boolean {
  return htlcSignatureValid('bsv', bsvRefundTx(coin, to, value, locktime), 0, coin.script, coin.amount, cosignPub, fromHex(cosig))
}

/** A v1 refund pays its lock less this fee, fixed when it is pre-signed. */
export function bsvRefundValue(amount: bigint): bigint {
  // One input (two signatures, script branch) and one P2PKH output: well under 400 bytes.
  return amount - BigInt(Math.ceil(400 * BSV_FEE_PER_BYTE))
}

/** The timestamp of BSV block `height`, from the same header source the lock's merkle path was checked against. */
async function bsvBlockTime(height: number): Promise<number | undefined> {
  try {
    const { requireActiveWallet } = await import('./settlePorts')
    const services = requireActiveWallet().services as { getHeaderForHeight?: (height: number) => Promise<number[]> }
    const header = await services.getHeaderForHeight?.(height)
    if (!header || header.length !== 80) return undefined
    return (header[68]! | (header[69]! << 8) | (header[70]! << 16)) + header[71]! * 0x1000000
  } catch {
    return undefined
  }
}

export const bsvLegChain: SwapLegChain = {
  chain: 'bsv',
  async proveLock(outpoint, lock, beef) {
    if (!beef) return { kind: 'unchecked', detail: 'no BEEF for the lock' }
    let tx: Transaction
    try {
      tx = bsvLockTx(beef, outpoint.txid)
    } catch (err) {
      return { kind: 'refused', reason: 'malformed', detail: err instanceof Error ? err.message : String(err) }
    }
    const out = tx.outputs[outpoint.vout]
    if (!out || out.lockingScript.toHex() !== toHex(lock.scriptPubKey)) return { kind: 'refused', reason: 'wrong-script', detail: 'the output is not the agreed lock' }
    if (BigInt(out.satoshis ?? 0) !== lock.amount) return { kind: 'refused', reason: 'under-backed', detail: `the lock holds ${out.satoshis}, not ${lock.amount}` }
    const { verifyBumpFinality } = await import('../spvFinality')
    const final = await verifyBumpFinality(outpoint.txid)
    if (final.ok) {
      const blockTime = await bsvBlockTime(final.height)
      return blockTime === undefined ? { kind: 'buried' } : { kind: 'buried', blockTime }
    }
    if (final.reason === 'invalid') return { kind: 'refused', reason: 'merkle', detail: 'the merkle path does not verify' }
    return { kind: 'unconfirmed' }
  },
  async spendOf(outpoint, _lock, hash) {
    try {
      const { whatsOnChainGet } = await import('../legacyScan')
      const { fetchRawTxHex } = await import('../oneSatImport')
      const { requireActiveWallet } = await import('./settlePorts')
      const chain = requireActiveWallet().chain
      const res = await whatsOnChainGet(chain, `/tx/${outpoint.txid}/${outpoint.vout}/spent`)
      if (!res) return { kind: 'unknown', detail: 'no answer about the lock' }
      if (res.status === 404) return { kind: 'unspent' }
      if (!res.ok) return { kind: 'unknown', detail: `spent lookup ${res.status}` }
      const body = (await res.json()) as { txid?: unknown }
      const spender = String(body.txid ?? '').toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(spender)) return { kind: 'unknown', detail: 'the spent lookup named no transaction' }
      const hex = await fetchRawTxHex(spender, chain)
      if (!hex) return { kind: 'unknown', detail: 'the spender body is unavailable' }
      const tx = parseLtcTx(fromHex(hex))
      if (ltcTxid(tx) !== spender) return { kind: 'unknown', detail: 'the spender body does not hash to its txid' }
      return judgeSpend('bsv', tx, outpoint, hash)
    } catch (err) {
      return { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) }
    }
  },
  async spendLock({ coins, key, path, fixed, sourceBeef, label }) {
    const lockTxid = coins[0]!.txid
    if (!sourceBeef) {
      const { requireActiveWallet } = await import('./settlePorts')
      const { getAtomicBeefBinaryForTxid } = await import('../beefCache')
      sourceBeef = b64(await getAtomicBeefBinaryForTxid(requireActiveWallet(), lockTxid))
    }
    const out = fixed ?? (await bsvSelfOutput())
    const signed = signHtlcSpend('bsv', {
      coins,
      to: out.to,
      key,
      path,
      ...(fixed ? { value: fixed.value } : { feeRate: BSV_FEE_PER_BYTE }),
    })
    const source = bsvLockTx(sourceBeef, lockTxid)
    const tx = Transaction.fromHex(signed.hex)
    for (const input of tx.inputs) {
      if (input.sourceTXID !== source.id('hex')) throw new Error('a BSV lock spend spends one lock transaction')
      input.sourceTransaction = source
    }
    if (tx.id('hex') !== signed.txid) throw new Error('the BSV lock spend changed when parsed')
    const atomic = tx.toAtomicBEEF(true)
    return {
      txid: signed.txid,
      hex: signed.hex,
      value: signed.tx.outputs[0]!.value,
      async commit() {
        const { requireActiveWallet, journalBsvSelfPayment } = await import('./settlePorts')
        const active = requireActiveWallet()
        journalBsvSelfPayment(active, `${signed.txid}.0`, signed.tx.outputs[0]!.value, out.remittance)
        const { registerSignedSend, propagateSignedSend } = await import('../signedSendLifecycle')
        await propagateSignedSend(await registerSignedSend({ txid: signed.txid, atomicBeef: atomic, flow: 'swap' }))
        await active.wallet.internalizeAction({
          tx: atomic,
          outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: out.remittance }],
          description: `Swap ${label}`.slice(0, 50),
          labels: ['swap'],
        })
        console.info(`[swap-settle] bsv ${label} ${signed.txid.slice(0, 12)} sent`)
      },
    }
  },
}

/** Lock BSV outputs without broadcasting: written down before it is broadcast (and, in v1, while the refunds are co-signed). */
export async function prepareBsvLock(outputs: readonly LegScript[], swapId: string): Promise<{ txid: string; beef: string }> {
  const { requireActiveWallet } = await import('./settlePorts')
  const active = requireActiveWallet()
  const created = await active.wallet.createAction({
    description: 'Swap lock',
    labels: ['swap', `swap:${swapId}`],
    outputs: outputs.map((o, i) => ({ lockingScript: toHex(o.scriptPubKey), satoshis: Number(o.amount), outputDescription: i === 0 ? 'Swap lock' : 'Swap fee lock' })),
    options: { noSend: true, randomizeOutputs: false, acceptDelayedBroadcast: true },
  })
  const txid = created.txid?.toLowerCase() ?? ''
  const atomic = created.tx ? Array.from(created.tx) : []
  if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('The swap lock was not signed')
  bsvLockTx(b64(atomic), txid).outputs.forEach((o, i) => {
    const want = outputs[i]
    if (want && (o.lockingScript.toHex() !== toHex(want.scriptPubKey) || BigInt(o.satoshis ?? 0) !== want.amount)) throw new Error('The swap lock was built with other outputs')
  })
  return { txid, beef: b64(atomic) }
}

/** Broadcast a prepared BSV lock (in v1, once its refunds are co-signed). */
export async function commitBsvLock(txid: string, beef: string): Promise<void> {
  const { registerSignedSend, propagateSignedSend } = await import('../signedSendLifecycle')
  await propagateSignedSend(await registerSignedSend({ txid, atomicBeef: unb64(beef), flow: 'swap' }))
}

/** Release a prepared BSV lock that will never be broadcast: its inputs return to the wallet. */
export async function abortBsvLock(txid: string): Promise<void> {
  const { requireActiveWallet } = await import('./settlePorts')
  await requireActiveWallet()
    .wallet.abortAction({ reference: txid })
    .catch((err: unknown) => console.warn(`[swap-settle] abort ${txid.slice(0, 12)} — ${err instanceof Error ? err.message : String(err)}`))
}

export async function legChainOf(chain: SwapAsset): Promise<SwapLegChain> {
  return chain === 'bsv' ? bsvLegChain : coinLegChain(chain)
}
