import { PrivateKey, Utils } from '@bsv/sdk'
import { BCH_FULCRUM_SERVERS, electrumBchChain, failoverBchChain } from '../bch/chain'
import { bchOutputScript } from '../bch/bitcoincash'
import { btcOutputScript } from '../btc/bitcoin'
import { BTC_ELECTRUM_SERVERS, electrumBtcChain } from '../btc/chain'
import { electrumSocket, failoverElectrumChain } from '../coins/electrumChain'
import { dogeOutputScript, parseDogeTx } from '../doge/dogecoin'
import { DOGE_ELECTRUM_SERVERS, electrumDogeChain } from '../doge/chain'
import { esploraLtcChain, LITECOINSPACE_API, type LtcChain } from '../ltc/chain'
import { concat, fromHex, hash160, ltcOutputScript, ltcTxid, p2wpkhScript, parseLtcTx, type Bytes, type LtcTx } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import { DIRECT_CLAIM_COST, HANDCASH_SWAP_FEE_PUB } from './fee'

export { HANDCASH_SWAP_FEE_PUB }
import { BSV_FEE_PER_BYTE, htlcOutput, htlcScript, readSecret, signHtlcSpend, type HtlcTerms } from './htlc'

/**
 * Claiming HandCash's swap fee outputs (BRC-CLOUD `swapFees.js`, vendored
 * from here by `npm run sync:swap-fees`).
 *
 * Both wallets of a swap report the fee leg's lock: its transaction, the fee
 * output and its sibling swap output, and the terms that rebuild both
 * scripts. Nothing reported is believed. The claimer rebuilds each script
 * from the terms and HandCash's key, checks the transaction holds them, and
 * waits for the swap output to be claimed: that spend reveals the secret,
 * which opens the fee output too. A swap output taken back by its payer
 * means the swap did not happen, and the fee output goes back the same way.
 */

export type FeeLockReport = {
  /** 1: a BSV lock's refund names the payee as co-signer. 2: it checks its own nLockTime, no co-signer. */
  v: 1 | 2
  chain: SwapAsset
  /** The fee leg's lock transaction. */
  txid: string
  /** The fee output. */
  vout: number
  /** The swap output beside it, whose claim reveals the secret. */
  mainVout: number
  /** The fee output's value, in the chain's smallest units. */
  amount: string
  /** sha256 of the swap secret. */
  hash: string
  /** Who locked the leg: the fee output's refund key. */
  payerPub: string
  /** Who the swap output pays; on BSV v1 also the refund co-signer. */
  payeePub: string
  /** Unix seconds: the fee output returns to its payer from here. */
  locktime: number
}

const CHAINS: readonly SwapAsset[] = ['bsv', 'ltc', 'bch', 'btc', 'doge']
const HEX64 = /^[0-9a-f]{64}$/
const PUB = /^0[23][0-9a-f]{64}$/
const UNITS = /^[1-9]\d{0,17}$/
/** Lock times far beyond a swap's 72 hours are not a swap's. */
const MAX_LOCK_AHEAD_S = 7 * 24 * 3600
/** No fee output smaller than this many of its own claim transactions (`fee.ts`). */
const FEE_FLOOR_CLAIMS = 10n

/** A report as the claimer stores it, or null for anything a wallet would not send. */
export function parseFeeLockReport(raw: unknown, nowS = Math.floor(Date.now() / 1000)): FeeLockReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const chain = r.chain as SwapAsset
  if ((r.v !== 1 && r.v !== 2) || !CHAINS.includes(chain)) return null
  if (typeof r.txid !== 'string' || !HEX64.test(r.txid) || typeof r.hash !== 'string' || !HEX64.test(r.hash)) return null
  if (!Number.isSafeInteger(r.vout) || !Number.isSafeInteger(r.mainVout) || (r.vout as number) < 0 || (r.mainVout as number) < 0 || r.vout === r.mainVout) return null
  if ((r.vout as number) > 1000 || (r.mainVout as number) > 1000) return null
  if (typeof r.amount !== 'string' || !UNITS.test(r.amount) || BigInt(r.amount) < DIRECT_CLAIM_COST[chain] * FEE_FLOOR_CLAIMS) return null
  if (typeof r.payerPub !== 'string' || !PUB.test(r.payerPub) || typeof r.payeePub !== 'string' || !PUB.test(r.payeePub) || r.payerPub === r.payeePub) return null
  if (!Number.isSafeInteger(r.locktime) || (r.locktime as number) < 500_000_000 || (r.locktime as number) > nowS + MAX_LOCK_AHEAD_S) return null
  return {
    v: r.v,
    chain,
    txid: r.txid,
    vout: r.vout as number,
    mainVout: r.mainVout as number,
    amount: r.amount,
    hash: r.hash,
    payerPub: r.payerPub,
    payeePub: r.payeePub,
    locktime: r.locktime as number,
  }
}

export const feeLockId = (r: Pick<FeeLockReport, 'chain' | 'txid' | 'vout'>): string => `${r.chain}:${r.txid}:${r.vout}`

export type FeeLockOutput = { script: Bytes; scriptPubKey: Bytes; address: string | null }

/** The fee output and its sibling swap output, rebuilt from the report and HandCash's key. */
export function feeLockScripts(r: FeeLockReport, feePub = HANDCASH_SWAP_FEE_PUB): { fee: FeeLockOutput; main: FeeLockOutput } {
  const base: Omit<HtlcTerms, 'claimPub'> = {
    hash: fromHex(r.hash),
    refundPub: fromHex(r.payerPub),
    locktime: r.locktime,
    ...(r.chain === 'bsv' && r.v === 1 ? { cosignPub: fromHex(r.payeePub) } : {}),
  }
  const build = (claimPub: string): FeeLockOutput => {
    const script = htlcScript(r.chain, { ...base, claimPub: fromHex(claimPub) })
    return { script, ...htlcOutput(r.chain, script) }
  }
  return { fee: build(feePub), main: build(r.payeePub) }
}

/** What the claimer reads from a chain. Every answer is checked by hash; a lying source only delays a claim. */
export type FeeChainReader = {
  /** The raw transaction, or null when no source knows it. */
  txHex(txid: string): Promise<string | null>
  /** The raw transaction spending `outpoint`, or null when it is unspent. */
  spenderHex(outpoint: { txid: string; vout: number }, out: FeeLockOutput): Promise<string | null>
  broadcast(hex: string): Promise<void>
  /** Smallest units per (virtual) byte. */
  feeRate(): Promise<number>
}

export type FeeLockVerdict =
  /** Nothing to do yet: the lock is not seen, or the swap output is unspent. */
  | { kind: 'pending'; detail: string }
  /** The transaction does not hold the reported outputs; never claimable. */
  | { kind: 'invalid'; detail: string }
  | { kind: 'claim'; secret: Bytes }
  /** The fee output is spent: by a claim (`claimed`) or by its payer. */
  | { kind: 'spent'; txid: string; claimed: boolean }
  /** The swap output went back to its payer: the swap did not happen, and the fee output follows it. */
  | { kind: 'refunded'; txid: string }

const parseTx = (chain: SwapAsset, raw: Bytes): LtcTx => (chain === 'doge' ? parseDogeTx(raw) : parseLtcTx(raw))

/** A transaction from its hex, refused unless it hashes to `txid` (when given). */
function checkedTx(chain: SwapAsset, hex: string, txid?: string): LtcTx {
  const tx = parseTx(chain, fromHex(hex))
  if (txid && ltcTxid(tx) !== txid) throw new Error('the transaction does not hash to its txid')
  return tx
}

const sameBytes = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i])

/** Where a reported fee lock stands, read from the chain. */
export async function judgeFeeLock(r: FeeLockReport, reader: FeeChainReader, feePub = HANDCASH_SWAP_FEE_PUB): Promise<FeeLockVerdict> {
  const outs = feeLockScripts(r, feePub)
  const hex = await reader.txHex(r.txid)
  if (!hex) return { kind: 'pending', detail: 'the lock is not seen yet' }
  const lock = checkedTx(r.chain, hex, r.txid)
  const fee = lock.outputs[r.vout]
  const main = lock.outputs[r.mainVout]
  if (!fee || !sameBytes(fee.script, outs.fee.scriptPubKey) || fee.value !== BigInt(r.amount)) return { kind: 'invalid', detail: 'the transaction holds no such fee output' }
  if (!main || !sameBytes(main.script, outs.main.scriptPubKey)) return { kind: 'invalid', detail: 'the transaction holds no such swap output' }
  const hash = fromHex(r.hash)

  const spentFee = await reader.spenderHex({ txid: r.txid, vout: r.vout }, outs.fee)
  if (spentFee) {
    const tx = checkedTx(r.chain, spentFee)
    const vin = tx.inputs.findIndex((i) => i.txid === r.txid && i.vout === r.vout)
    if (vin < 0) return { kind: 'pending', detail: 'the named fee spender does not spend it' }
    return { kind: 'spent', txid: ltcTxid(tx), claimed: readSecret(r.chain, tx, vin, hash) !== null }
  }

  const spentMain = await reader.spenderHex({ txid: r.txid, vout: r.mainVout }, outs.main)
  if (!spentMain) return { kind: 'pending', detail: 'the swap output is not claimed yet' }
  const tx = checkedTx(r.chain, spentMain)
  const vin = tx.inputs.findIndex((i) => i.txid === r.txid && i.vout === r.mainVout)
  if (vin < 0) return { kind: 'pending', detail: 'the named swap spender does not spend it' }
  const secret = readSecret(r.chain, tx, vin, hash)
  return secret ? { kind: 'claim', secret } : { kind: 'refunded', txid: ltcTxid(tx) }
}

/** The output a claim pays: `address` when set, else the fee key's own address on the chain. */
export function feePayoutScript(chain: SwapAsset, feePub: string, address?: string): Bytes {
  if (address) {
    switch (chain) {
      case 'ltc':
        return ltcOutputScript(address)
      case 'btc':
        return btcOutputScript(address)
      case 'bch':
        return bchOutputScript(address)
      case 'doge':
        return dogeOutputScript(address)
      case 'bsv':
        return p2pkh(bsvAddressHash(address))
    }
  }
  const pub = fromHex(feePub)
  return chain === 'ltc' || chain === 'btc' ? p2wpkhScript(pub) : p2pkh(hash160(pub))
}

const p2pkh = (h: Bytes): Bytes => concat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac))

/** The key hash a BSV mainnet P2PKH address names. */
function bsvAddressHash(address: string): Bytes {
  const parsed = Utils.fromBase58Check(address.trim()) as { prefix: number[]; data: number[] }
  if (parsed.prefix.length !== 1 || parsed.prefix[0] !== 0x00 || parsed.data.length !== 20) throw new Error('not a BSV mainnet address')
  return Uint8Array.from(parsed.data)
}

/** The claim of a fee output with the secret, paying `payout`. */
export function signFeeClaim(r: FeeLockReport, secret: Bytes, keyHex: string, payout: Bytes, feeRate: number, feePub = HANDCASH_SWAP_FEE_PUB): { hex: string; txid: string; value: bigint } {
  const key = PrivateKey.fromHex(keyHex)
  if (key.toPublicKey().toString() !== feePub) throw new Error('the fee key does not match the fee public key')
  const { fee } = feeLockScripts(r, feePub)
  const signed = signHtlcSpend(r.chain, {
    coins: [{ txid: r.txid, vout: r.vout, amount: BigInt(r.amount), script: fee.script }],
    to: payout,
    key,
    path: { kind: 'claim', preimage: secret },
    feeRate: r.chain === 'bsv' ? BSV_FEE_PER_BYTE : feeRate,
  })
  return { hex: signed.hex, txid: signed.txid, value: signed.tx.outputs[0]!.value }
}

// ── Readers ───────────────────────────────────────────────────────────────

/** A coin chain read through the wallet's own sources. Opened fresh per run: a Worker cannot share sockets across requests. */
export function coinFeeReader(chain: Exclude<SwapAsset, 'bsv'>): FeeChainReader {
  const src: LtcChain = (() => {
    switch (chain) {
      case 'ltc':
        return esploraLtcChain(LITECOINSPACE_API)
      case 'bch':
        return failoverBchChain(BCH_FULCRUM_SERVERS.map((u) => electrumBchChain(electrumSocket(u))))
      case 'btc':
        return failoverElectrumChain(BTC_ELECTRUM_SERVERS.map((u) => electrumBtcChain(electrumSocket(u))), 'Bitcoin')
      case 'doge':
        return failoverElectrumChain(DOGE_ELECTRUM_SERVERS.map((u) => electrumDogeChain(electrumSocket(u))), 'Dogecoin')
    }
  })()
  return {
    async txHex(txid) {
      try {
        return await src.txHex(txid)
      } catch (err) {
        if (/not found|no transaction|404/i.test(err instanceof Error ? err.message : String(err))) return null
        throw err
      }
    },
    async spenderHex(outpoint, out) {
      if (!out.address || !src.scriptHistory) throw new Error(`${chain}: no address history to find a spender`)
      for (const txid of await src.scriptHistory(out.address)) {
        if (txid === outpoint.txid) continue
        const hex = await src.txHex(txid)
        const tx = checkedTx(chain, hex, txid)
        if (tx.inputs.some((i) => i.txid === outpoint.txid && i.vout === outpoint.vout)) return hex
      }
      return null
    },
    async broadcast(hex) {
      await src.broadcast(hex)
    },
    feeRate: () => src.feeRate(),
  }
}

export const WHATSONCHAIN_API = 'https://api.whatsonchain.com/v1/bsv/main'

/** BSV read through WhatsOnChain. */
export function bsvFeeReader(opts: { fetch?: typeof fetch; apiKey?: string } = {}): FeeChainReader {
  const call = (path: string, init?: RequestInit) =>
    (opts.fetch ?? fetch)(`${WHATSONCHAIN_API}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(opts.apiKey ? { Authorization: opts.apiKey } : {}), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })
  const txHex = async (txid: string): Promise<string | null> => {
    const res = await call(`/tx/${txid}/hex`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`WhatsOnChain tx ${res.status}`)
    return (await res.text()).trim().toLowerCase()
  }
  return {
    txHex,
    async spenderHex(outpoint) {
      const res = await call(`/tx/${outpoint.txid}/${outpoint.vout}/spent`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`WhatsOnChain spent ${res.status}`)
      const body = (await res.json()) as { txid?: unknown }
      const txid = String(body.txid ?? '').toLowerCase()
      if (!HEX64.test(txid)) throw new Error('WhatsOnChain named no spender')
      const hex = await txHex(txid)
      if (!hex) throw new Error('the spender body is unavailable')
      checkedTx('bsv', hex, txid)
      return hex
    },
    async broadcast(hex) {
      const res = await call('/tx/raw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (!/already|txn-already-known|257/i.test(text)) throw new Error(`WhatsOnChain broadcast ${res.status}: ${text.slice(0, 160)}`)
      }
    },
    feeRate: async () => BSV_FEE_PER_BYTE,
  }
}

export const feeReaderOf = (chain: SwapAsset, bsv: { fetch?: typeof fetch; apiKey?: string } = {}): FeeChainReader =>
  chain === 'bsv' ? bsvFeeReader(bsv) : coinFeeReader(chain)
