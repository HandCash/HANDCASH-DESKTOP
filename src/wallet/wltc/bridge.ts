import { Hash, KeyDeriver, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { createActor } from 'xstate'
import { wltcMachine } from '../../machines/wltcMachine'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { durableGetItem, durableSetItem } from '../durableStorage'
import type { ActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'
import { defaultLtcChain, type LtcChain } from './chain'
import {
  formatLtc,
  ltcOutputScript,
  ltcTxid as payoutTxid,
  p2wpkhAddress,
  p2wpkhScript,
  serializeLtcTx,
  signP2wpkhInputs,
  toHex,
  type LtcTx,
} from './litecoin'
import { confirmationsFor, verifyLtcDeposit, type DepositRefusal, type VerifyOptions } from './verify'

/**
 * wLTC: Litecoin wrapped as an open BRC-255 token, with this wallet as a
 * 1-of-1 federation. The wallet holds the LTC reserve key, mints wLTC to
 * itself for each deposit it has proven by SPV, and burns wLTC for each
 * withdrawal it pays from the reserve. Every wLTC unit is one litoshi held at
 * the reserve address; nobody else can mint it, and only this wallet can pay
 * the LTC out.
 */

export const WLTC_RESERVE_PROTOCOL: [2, string] = [2, 'wltc reserve']
const RESERVE_KEY_ID = '1'
export const WLTC_SYM = 'wLTC'
export const WLTC_DECIMALS = 8
/** Smallest output a withdrawal pays or keeps as change, in litoshi. */
export const LTC_DUST = 1_000n
const P2WPKH_INPUT_VBYTES = 68
const TX_OVERHEAD_VBYTES = 11
const MAX_INPUTS = 50
const DEPOSIT_LABEL = 'wltc deposit'
const REDEEM_LABEL = 'wltc redeem'

export class WltcRefusal extends Error {
  constructor(
    readonly reason: 'bad-args' | 'no-asset' | 'insufficient' | 'reserve-short',
    message: string,
  ) {
    super(message)
    this.name = 'WltcRefusal'
  }
}

function refuse(reason: WltcRefusal['reason'], message: string): never {
  console.warn(`[wltc] refuse ${reason} — ${message}`)
  throw new WltcRefusal(reason, message)
}

// ── Keys ───────────────────────────────────────────────────────────────────

export function wltcReserveKey(root: PrivateKey): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(WLTC_RESERVE_PROTOCOL, RESERVE_KEY_ID, 'self')
}

const pubBytes = (key: PrivateKey) => Uint8Array.from(key.toPublicKey().encode(true) as number[])

/**
 * The holder burned wLTC is locked to: the first `"wLTC burn <i>"` digest that
 * is the x coordinate of a curve point. Nobody knows its private key.
 */
export const WLTC_BURN_HOLDER: string = (() => {
  for (let i = 0; ; i++) {
    const x = Utils.toHex(Hash.sha256(Utils.toArray(`wLTC burn ${i}`, 'utf8')))
    try {
      return PublicKey.fromString(`02${x}`).toString()
    } catch {
      // not on the curve; next counter
    }
  }
})()

// ── State ──────────────────────────────────────────────────────────────────

type DepositRecord = { litoshi: string; status: 'minting' | 'credited'; bsvTxid?: string; at: number }

type WithdrawalRecord = {
  address: string
  litoshi: string
  fee: string
  burn: string
  hex: string
  /** `txid:vout` of each reserve output it spends. */
  inputs: string[]
  change?: { vout: number; litoshi: string }
  status: 'signed' | 'burned' | 'sent'
  bsvTxid?: string
  at: number
  attempts: number
  lastError?: string
}

type WltcState = {
  assetId?: string
  deposits: Record<string, DepositRecord>
  withdrawals: Record<string, WithdrawalRecord>
}

const stateKey = () => accountLocalKey(storageRegistry.wltc.key)

function readState(): WltcState {
  try {
    const parsed = JSON.parse(durableGetItem(stateKey()) ?? '{}') as Partial<WltcState>
    return { ...(parsed.assetId ? { assetId: parsed.assetId } : {}), deposits: parsed.deposits ?? {}, withdrawals: parsed.withdrawals ?? {} }
  } catch {
    return { deposits: {}, withdrawals: {} }
  }
}

function writeState(state: WltcState): void {
  if (!durableSetItem(stateKey(), JSON.stringify(state))) throw new Error('The wLTC record could not be saved.')
}

const outpointKey = (txid: string, vout: number) => `${txid}:${vout}`

// ── Runtime ────────────────────────────────────────────────────────────────

type Deps = { chain: LtcChain; verify: VerifyOptions }
let deps: Deps = { chain: defaultLtcChain(), verify: {} }

/** Tests swap the explorer and verifier options. */
export function setWltcDepsForTest(next: Partial<Deps> | null): void {
  deps = next ? { ...deps, ...next } : { chain: defaultLtcChain(), verify: {} }
}

function requireActive(): ActiveWallet {
  const active = getWalletRuntime()?.instance ?? null
  if (!active) throw new Error('Wallet locked')
  return active
}

function reserveOf(active: ActiveWallet): { key: PrivateKey; address: string; script: Uint8Array } {
  const key = wltcReserveKey(PrivateKey.fromHex(active.rootKeyHex))
  const pub = pubBytes(key)
  return { key, address: p2wpkhAddress(pub), script: p2wpkhScript(pub) }
}

let tail: Promise<unknown> = Promise.resolve()

/** Credit passes and withdrawals run one at a time, so no outpoint is minted or spent twice in flight. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.catch(() => {})
  return run
}

async function hasLabelledAction(active: ActiveWallet, label: string): Promise<boolean> {
  const page = await active.wallet.listActions({ labels: [label], labelQueryMode: 'any', limit: 10 })
  return (page.actions ?? []).some((a) => a.status !== 'failed')
}

async function wltcAssetId(active: ActiveWallet, state: WltcState): Promise<string | null> {
  if (state.assetId) return state.assetId
  const { listHctAssets } = await import('../hct/wallet')
  const self = active.identityKey.toLowerCase()
  const found = (await listHctAssets()).assets.find(
    (a) => a.mode === 'open' && a.kind === 'token' && a.sym === WLTC_SYM && a.authority && a.issuers.includes(self),
  )
  return found?.assetId ?? null
}

async function wltcBalance(assetId: string | null): Promise<bigint> {
  if (!assetId) return 0n
  const { listHctAssets } = await import('../hct/wallet')
  const asset = (await listHctAssets()).assets.find((a) => a.assetId === assetId)
  return asset ? BigInt(asset.balance) : 0n
}

// ── Address ────────────────────────────────────────────────────────────────

export type LtcDepositAddress = {
  network: 'litecoin'
  address: string
  asset: typeof WLTC_SYM
  assetId: string | null
  decimals: number
  minConfirmations: number
}

export async function getLtcDepositAddress(): Promise<LtcDepositAddress> {
  const active = requireActive()
  const state = readState()
  return {
    network: 'litecoin',
    address: reserveOf(active).address,
    asset: WLTC_SYM,
    assetId: await wltcAssetId(active, state),
    decimals: WLTC_DECIMALS,
    minConfirmations: confirmationsFor(1n),
  }
}

// ── Credit ─────────────────────────────────────────────────────────────────

export type LtcDepositStatus =
  | { txid: string; vout: number; litoshi: string; status: 'credited'; bsvTxid?: string }
  | { txid: string; vout: number; litoshi: string; status: 'pending'; confirmations: number; needed: number }
  | { txid: string; vout: number; status: 'refused'; reason: DepositRefusal; detail: string }
  | { txid: string; vout: number; litoshi: string; status: 'failed'; error: string }

export type LtcWithdrawalStatus = {
  ltcTxid: string
  address: string
  litoshi: string
  fee: string
  status: 'burned' | 'sent'
  bsvTxid?: string
  lastError?: string
}

export type LtcDepositsResult = {
  address: string
  assetId: string | null
  /** wLTC this wallet holds, in litoshi. */
  balance: string
  deposits: LtcDepositStatus[]
  withdrawals: LtcWithdrawalStatus[]
}

/** Mint one proven deposit; the label names the outpoint so a restored wallet finds it. */
async function mintDeposit(active: ActiveWallet, txid: string, vout: number, litoshi: bigint): Promise<string | undefined> {
  const key = outpointKey(txid, vout)
  const label = `${DEPOSIT_LABEL} ${txid}.${vout}`
  let state = readState()
  const prior = state.deposits[key]
  if (prior?.status === 'credited') return prior.bsvTxid
  if (prior?.status === 'minting' && (await hasLabelledAction(active, label))) {
    state.deposits[key] = { ...prior, status: 'credited' }
    writeState(state)
    return undefined
  }
  state.deposits[key] = { litoshi: litoshi.toString(), status: 'minting', at: Date.now() }
  writeState(state)
  const hct = await import('../hct/wallet')
  const assetId = await wltcAssetId(active, state)
  const labels = [label]
  let bsvTxid: string
  if (assetId) {
    bsvTxid = (await hct.mintHctAsset({ assetId, amount: litoshi.toString() }, { labels })).txid
  } else {
    const issued = await hct.issueHctAsset(
      { kind: 'token', sym: WLTC_SYM, name: 'Wrapped Litecoin', dec: WLTC_DECIMALS, supply: litoshi.toString(), auth: true },
      { labels },
    )
    bsvTxid = issued.txid
    state = readState()
    state.assetId = issued.assetId
    writeState(state)
  }
  state = readState()
  if (!state.assetId && assetId) state.assetId = assetId
  state.deposits[key] = { litoshi: litoshi.toString(), status: 'credited', bsvTxid, at: Date.now() }
  writeState(state)
  return bsvTxid
}

async function creditPass(active: ActiveWallet): Promise<LtcDepositStatus[]> {
  const { address, script } = reserveOf(active)
  const state = readState()
  const ownChange = new Set(
    Object.entries(state.withdrawals).flatMap(([txid, w]) => (w.change ? [outpointKey(txid, w.change.vout)] : [])),
  )
  const statuses: LtcDepositStatus[] = []
  for (const utxo of await deps.chain.addressUtxos(address)) {
    const key = outpointKey(utxo.txid, utxo.vout)
    if (ownChange.has(key) || state.deposits[key]?.status === 'credited') continue
    const chart = createActor(wltcMachine).start()
    chart.send({ type: 'CREDIT' })
    try {
      const verdict = await verifyLtcDeposit(deps.chain, { txid: utxo.txid, vout: utxo.vout }, script, deps.verify)
      if (verdict.kind === 'refuse') {
        chart.send({ type: 'REFUSED', error: verdict.reason })
        statuses.push({ txid: utxo.txid, vout: utxo.vout, status: 'refused', reason: verdict.reason, detail: verdict.detail })
        continue
      }
      if (verdict.kind === 'pending') {
        chart.send({ type: 'PENDING' })
        statuses.push({ txid: utxo.txid, vout: utxo.vout, litoshi: verdict.litoshi.toString(), status: 'pending', confirmations: verdict.confirmations, needed: verdict.needed })
        continue
      }
      chart.send({ type: 'VERIFIED' })
      const startedAt = Date.now()
      const bsvTxid = await mintDeposit(active, utxo.txid, utxo.vout, verdict.litoshi)
      chart.send({ type: 'MINTED', bsvTxid: bsvTxid ?? '' })
      const ms = Date.now() - startedAt
      if (ms > 250) console.info(`[wltc] mint done ${ms}ms`)
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'wltc-credit',
        note: `Credited ${formatLtc(verdict.litoshi)} wLTC for LTC deposit ${utxo.txid.slice(0, 12)}…`,
        ...(bsvTxid ? { txid: bsvTxid } : {}),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      chart.send({ type: 'FAIL', error })
      console.warn(`[wltc] credit ${key} failed — ${error}`)
      statuses.push({ txid: utxo.txid, vout: utxo.vout, litoshi: String(utxo.value), status: 'failed', error })
    } finally {
      chart.stop()
    }
  }
  return statuses
}

function report(active: ActiveWallet, assetId: string | null, balance: bigint, live: LtcDepositStatus[]): LtcDepositsResult {
  const state = readState()
  const credited: LtcDepositStatus[] = Object.entries(state.deposits)
    .filter(([, d]) => d.status === 'credited')
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([key, d]) => {
      const [txid, vout] = key.split(':')
      return { txid: txid!, vout: Number(vout), litoshi: d.litoshi, status: 'credited', ...(d.bsvTxid ? { bsvTxid: d.bsvTxid } : {}) }
    })
  const withdrawals: LtcWithdrawalStatus[] = Object.entries(state.withdrawals)
    .filter(([, w]) => w.status !== 'signed')
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([ltcTxid, w]) => ({
      ltcTxid,
      address: w.address,
      litoshi: w.litoshi,
      fee: w.fee,
      status: w.status as 'burned' | 'sent',
      ...(w.bsvTxid ? { bsvTxid: w.bsvTxid } : {}),
      ...(w.lastError ? { lastError: w.lastError } : {}),
    }))
  return { address: reserveOf(active).address, assetId, balance: balance.toString(), deposits: [...live, ...credited], withdrawals }
}

/**
 * Every deposit to the reserve address and what became of it. Proven deposits
 * are minted as wLTC to this wallet during the call: minting against an LTC
 * output the wallet itself proved is receiving, and an app cannot cause one
 * without a real deposit to this wallet's own reserve.
 */
export function listLtcDeposits(): Promise<LtcDepositsResult> {
  return serial(async () => {
    const active = requireActive()
    await settleWithdrawals(active)
    const live = await creditPass(active)
    const assetId = await wltcAssetId(active, readState())
    return report(active, assetId, await wltcBalance(assetId), live)
  })
}

// ── Withdraw ───────────────────────────────────────────────────────────────

export type WithdrawLtcResult = {
  ltcTxid: string
  bsvTxid: string
  litoshi: string
  fee: string
  burned: string
  status: 'sent' | 'burned'
}

const outputVbytes = (script: Uint8Array) => 9 + script.length

/** Spendable reserve outputs with the amounts this wallet recorded (never the explorer's). */
function backedOutputs(state: WltcState, unspent: ReadonlySet<string>): Array<{ txid: string; vout: number; litoshi: bigint }> {
  const reserved = new Set(
    Object.values(state.withdrawals)
      .filter((w) => w.status !== 'sent')
      .flatMap((w) => w.inputs),
  )
  const out: Array<{ txid: string; vout: number; litoshi: bigint }> = []
  for (const [key, d] of Object.entries(state.deposits)) {
    if (d.status !== 'credited' || reserved.has(key) || !unspent.has(key)) continue
    const [txid, vout] = key.split(':')
    out.push({ txid: txid!, vout: Number(vout), litoshi: BigInt(d.litoshi) })
  }
  for (const [txid, w] of Object.entries(state.withdrawals)) {
    if (w.status !== 'sent' || !w.change) continue
    const key = outpointKey(txid, w.change.vout)
    if (reserved.has(key) || !unspent.has(key)) continue
    out.push({ txid, vout: w.change.vout, litoshi: BigInt(w.change.litoshi) })
  }
  return out.sort((a, b) => (b.litoshi > a.litoshi ? 1 : b.litoshi < a.litoshi ? -1 : 0))
}

export type LtcWithdrawalPlan = {
  tx: LtcTx
  amounts: bigint[]
  inputs: string[]
  fee: bigint
  change?: { vout: number; litoshi: bigint }
  burn: bigint
}

/**
 * Choose reserve outputs and build the unsigned payout. The fee and any
 * remainder too small to keep as change are burned with the amount, so every
 * remaining wLTC unit stays backed by a litoshi at the reserve.
 */
export function planLtcWithdrawal(
  coins: ReadonlyArray<{ txid: string; vout: number; litoshi: bigint }>,
  destination: Uint8Array,
  reserveScript: Uint8Array,
  litoshi: bigint,
  feeRate: number,
): LtcWithdrawalPlan | null {
  const rate = BigInt(Math.max(1, Math.ceil(feeRate)))
  const chosen: typeof coins[number][] = []
  let sum = 0n
  for (const coin of coins) {
    if (chosen.length >= MAX_INPUTS) break
    chosen.push(coin)
    sum += coin.litoshi
    const base = TX_OVERHEAD_VBYTES + P2WPKH_INPUT_VBYTES * chosen.length + outputVbytes(destination)
    const feeWithChange = rate * BigInt(base + outputVbytes(reserveScript))
    const feeNoChange = rate * BigInt(base)
    const tx = (outputs: LtcTx['outputs']): LtcTx => ({
      version: 2,
      inputs: chosen.map((c) => ({ txid: c.txid, vout: c.vout, script: new Uint8Array(), sequence: 0xfffffffd, witness: [] })),
      outputs,
      locktime: 0,
    })
    const inputs = chosen.map((c) => outpointKey(c.txid, c.vout))
    const amounts = chosen.map((c) => c.litoshi)
    if (sum >= litoshi + feeWithChange + LTC_DUST) {
      const changeValue = sum - litoshi - feeWithChange
      return {
        tx: tx([{ value: litoshi, script: destination }, { value: changeValue, script: reserveScript }]),
        amounts,
        inputs,
        fee: feeWithChange,
        change: { vout: 1, litoshi: changeValue },
        burn: litoshi + feeWithChange,
      }
    }
    if (sum >= litoshi + feeNoChange) {
      return { tx: tx([{ value: litoshi, script: destination }]), amounts, inputs, fee: sum - litoshi, burn: sum }
    }
  }
  return null
}

async function broadcastWithdrawal(ltcTxid: string, record: WithdrawalRecord): Promise<boolean> {
  try {
    const status = await deps.chain.txStatus(ltcTxid).catch(() => null)
    if (!status) await deps.chain.broadcast(record.hex)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const state = readState()
    const current = state.withdrawals[ltcTxid]
    if (current) {
      current.attempts += 1
      current.lastError = message
      writeState(state)
    }
    console.warn(`[wltc] withdrawal ${ltcTxid} broadcast queued — ${message}`)
    return false
  }
}

function markSent(ltcTxid: string): void {
  const state = readState()
  const w = state.withdrawals[ltcTxid]
  if (!w) return
  w.status = 'sent'
  delete w.lastError
  writeState(state)
}

/**
 * Finish what a crash or an outage interrupted. A burned withdrawal is
 * re-broadcast until it lands. A signed one whose burn never committed is
 * dropped (its LTC was never sent); one whose burn did commit is promoted.
 */
async function settleWithdrawals(active: ActiveWallet): Promise<void> {
  const state = readState()
  for (const [ltcTxid, w] of Object.entries(state.withdrawals)) {
    if (w.status === 'signed') {
      if (await hasLabelledAction(active, `${REDEEM_LABEL} ${ltcTxid}`)) {
        const next = readState()
        next.withdrawals[ltcTxid] = { ...w, status: 'burned' }
        writeState(next)
      } else {
        const next = readState()
        delete next.withdrawals[ltcTxid]
        writeState(next)
        continue
      }
    }
    if (readState().withdrawals[ltcTxid]?.status !== 'burned') continue
    const chart = createActor(wltcMachine).start()
    chart.send({ type: 'RESUME_BROADCAST', ltcTxid })
    if (await broadcastWithdrawal(ltcTxid, w)) {
      markSent(ltcTxid)
      chart.send({ type: 'BROADCASTED' })
    } else {
      chart.send({ type: 'BROADCAST_QUEUED', error: readState().withdrawals[ltcTxid]?.lastError ?? 'broadcast failed' })
    }
    chart.stop()
  }
}

/**
 * Pay `litoshi` LTC from the reserve to `address`, burning that much wLTC plus
 * the Litecoin fee. Sign the LTC payout first and keep it unsent, burn, then
 * broadcast; a failed burn sends nothing, a failed broadcast is retried.
 */
export function withdrawLtc(args: { address?: unknown; litoshi?: unknown }): Promise<WithdrawLtcResult> {
  return serial(async () => {
    const active = requireActive()
    const startedAt = Date.now()
    const chart = createActor(wltcMachine).start()
    chart.send({ type: 'WITHDRAW' })
    try {
      const address = typeof args.address === 'string' ? args.address.trim() : ''
      let destination: Uint8Array
      try {
        destination = ltcOutputScript(address)
      } catch (err) {
        return refuse('bad-args', `address is not a Litecoin mainnet address (${err instanceof Error ? err.message : String(err)}).`)
      }
      const raw = String(args.litoshi ?? '').trim()
      if (!/^\d+$/.test(raw) || BigInt(raw) < LTC_DUST) refuse('bad-args', `litoshi is a whole number, at least ${LTC_DUST}.`)
      const litoshi = BigInt(raw)
      await settleWithdrawals(active)
      const state = readState()
      const assetId = await wltcAssetId(active, state)
      if (!assetId) refuse('no-asset', 'This wallet has not minted any wLTC yet.')
      const reserve = reserveOf(active)
      const unspent = new Set((await deps.chain.addressUtxos(reserve.address)).map((u) => outpointKey(u.txid, u.vout)))
      const plan = planLtcWithdrawal(backedOutputs(state, unspent), destination, reserve.script, litoshi, await deps.chain.feeRate())
      if (!plan) refuse('reserve-short', `The reserve cannot pay ${formatLtc(litoshi)} LTC plus its fee from credited deposits.`)
      const balance = await wltcBalance(assetId)
      if (balance < plan.burn) {
        refuse('insufficient', `Withdrawing ${formatLtc(litoshi)} LTC burns ${formatLtc(plan.burn)} wLTC with the fee; this wallet holds ${formatLtc(balance)}.`)
      }
      const signed = signP2wpkhInputs(plan.tx, reserve.key, plan.amounts)
      const ltcTxid = payoutTxid(signed)
      const record: WithdrawalRecord = {
        address,
        litoshi: litoshi.toString(),
        fee: plan.fee.toString(),
        burn: plan.burn.toString(),
        hex: toHex(serializeLtcTx(signed)),
        inputs: plan.inputs,
        ...(plan.change ? { change: { vout: plan.change.vout, litoshi: plan.change.litoshi.toString() } } : {}),
        status: 'signed',
        at: Date.now(),
        attempts: 0,
      }
      const next = readState()
      next.withdrawals[ltcTxid] = record
      writeState(next)
      chart.send({ type: 'LTC_SIGNED', ltcTxid })

      const { burnHctUnits } = await import('../hct/wallet')
      let bsvTxid: string
      try {
        bsvTxid = (
          await burnHctUnits(
            { assetId: assetId!, amount: plan.burn, holder: WLTC_BURN_HOLDER, memo: `wltc-redeem ${ltcTxid}` },
            { labels: [`${REDEEM_LABEL} ${ltcTxid}`] },
          )
        ).txid
      } catch (err) {
        const dropped = readState()
        delete dropped.withdrawals[ltcTxid]
        writeState(dropped)
        throw err
      }
      const burned = readState()
      burned.withdrawals[ltcTxid] = { ...record, status: 'burned', bsvTxid }
      writeState(burned)
      chart.send({ type: 'BURNED', bsvTxid })

      const sent = await broadcastWithdrawal(ltcTxid, record)
      if (sent) {
        markSent(ltcTxid)
        chart.send({ type: 'BROADCASTED' })
      } else {
        chart.send({ type: 'BROADCAST_QUEUED', error: readState().withdrawals[ltcTxid]?.lastError ?? 'broadcast failed' })
      }
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'wltc-withdraw',
        note: `Withdrew ${formatLtc(litoshi)} LTC to ${address.slice(0, 14)}… (burned ${formatLtc(plan.burn)} wLTC)`,
        txid: bsvTxid,
      })
      const ms = Date.now() - startedAt
      if (ms > 250) console.info(`[wltc] withdraw done ${ms}ms`)
      return { ltcTxid, bsvTxid, litoshi: litoshi.toString(), fee: plan.fee.toString(), burned: plan.burn.toString(), status: sent ? 'sent' : 'burned' }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  })
}

