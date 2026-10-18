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
import type { LtcDepositPhase, LtcDepositView } from './depositPhase'
import { checkLtcBurial, locateLtcDeposit, LTC_BURIAL_DEPTH, readLtcDeposit, type DepositRefusal, type LtcBurialProof } from './verify'

/**
 * wLTC: Litecoin wrapped as an open, backed BRC-255 token, with this wallet as
 * a 1-of-1 federation. The wallet holds the LTC reserve key and mints wLTC to
 * itself the moment a deposit is seen paying the reserve, like an unproven
 * BSV payment: the balance is UTXO state at once. Those units cannot move
 * until the deposit's burial proof exists; every receiver checks that proof,
 * so a deposit that is double-spent never yields wLTC anyone accepts. The
 * wallet burns wLTC for each withdrawal it pays from proven deposits. Every
 * movable wLTC unit is one litoshi buried at the reserve address.
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

type DepositRecord = {
  litoshi: string
  status: 'minting' | 'credited'
  bsvTxid?: string
  at: number
  /** Minted against the backed asset: false until its burial proof is recorded. Absent on deposits credited after burial (before 1.3.601). */
  proven?: boolean
  /** When the explorers first stopped knowing the deposit; it is void once that lasts past `VOID_AFTER_MS`. */
  goneAt?: number
  /** Where the deposit stands on this wallet's own Litecoin chain (unproven deposits only). */
  phase?: LtcDepositPhase
  /** Burial proof built from an explorer's answer, kept while it is too shallow, so later checks need only this wallet's chain. */
  proof?: LtcBurialProof
}

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
  /** The unbacked wLTC of earlier versions; its deposits were credited only after burial. */
  assetId?: string
  /** The backed wLTC (BRC-255 `bk` naming this reserve): minted at first sight, movable once proven. */
  backedAssetId?: string
  deposits: Record<string, DepositRecord>
  withdrawals: Record<string, WithdrawalRecord>
  /** Until when the watcher looks for new deposits: set each time the deposit address is handed out. */
  expectUntil?: number
}

const stateKey = () => accountLocalKey(storageRegistry.wltc.key)

function readState(): WltcState {
  try {
    const parsed = JSON.parse(durableGetItem(stateKey()) ?? '{}') as Partial<WltcState>
    return {
      ...(parsed.assetId ? { assetId: parsed.assetId } : {}),
      ...(parsed.backedAssetId ? { backedAssetId: parsed.backedAssetId } : {}),
      ...(typeof parsed.expectUntil === 'number' ? { expectUntil: parsed.expectUntil } : {}),
      deposits: parsed.deposits ?? {},
      withdrawals: parsed.withdrawals ?? {},
    }
  } catch {
    return { deposits: {}, withdrawals: {} }
  }
}

const listeners = new Set<() => void>()

function writeState(state: WltcState): void {
  if (!durableSetItem(stateKey(), JSON.stringify(state))) throw new Error('The wLTC record could not be saved.')
  for (const listener of listeners) listener()
}

/** Called after every change to the deposit record. */
export function subscribeLtcDeposits(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const outpointKey = (txid: string, vout: number) => `${txid}:${vout}`
/** A deposit the explorers have not known for this long is shown void; its wLTC moves only if it later reaches a block. */
const VOID_AFTER_MS = 30 * 60_000
const isProven = (d: DepositRecord) => d.status === 'credited' && d.proven !== false

// ── Runtime ────────────────────────────────────────────────────────────────

type Deps = { chain: LtcChain }
let deps: Deps = { chain: defaultLtcChain() }

/** Tests swap the explorer. */
export function setWltcDepsForTest(next: Partial<Deps> | null): void {
  deps = next ? { ...deps, ...next } : { chain: defaultLtcChain() }
}

function requireActive(): ActiveWallet {
  const active = getWalletRuntime()?.instance ?? null
  if (!active) throw new Error('Wallet locked')
  return active
}

function reserveOf(active: ActiveWallet): { key: PrivateKey; address: string; script: Uint8Array; scriptHex: string } {
  const key = wltcReserveKey(PrivateKey.fromHex(active.rootKeyHex))
  const pub = pubBytes(key)
  const script = p2wpkhScript(pub)
  return { key, address: p2wpkhAddress(pub), script, scriptHex: toHex(script) }
}

let tail: Promise<unknown> = Promise.resolve()

/** Credit passes and withdrawals run one at a time, so no outpoint is minted or spent twice in flight. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.catch(() => {})
  return run
}

/** An action in these states is signed; `unsigned` is a build that may still abort, never a mint. */
const SIGNED_ACTION_STATUSES = new Set(['completed', 'unproven', 'sending', 'nosend', 'unprocessed'])

/** The txid of the signed, live action carrying `label`, or null. */
async function labelledAction(active: ActiveWallet, label: string): Promise<string | null> {
  const page = await active.wallet.listActions({ labels: [label], labelQueryMode: 'any', limit: 10 })
  const hit = (page.actions ?? []).find((a) => SIGNED_ACTION_STATUSES.has(a.status) && /^[0-9a-f]{64}$/i.test(String(a.txid ?? '')))
  return hit ? String(hit.txid).toLowerCase() : null
}

async function hasLabelledAction(active: ActiveWallet, label: string): Promise<boolean> {
  return (await labelledAction(active, label)) !== null
}

type WltcHolding = { assetId: string; balance: bigint; locked: bigint }

/** The backed wLTC (minting) and the unbacked wLTC of earlier versions this wallet issued, with balances. */
async function wltcHoldings(active: ActiveWallet, state: WltcState): Promise<{ backed: WltcHolding | null; legacy: WltcHolding | null }> {
  const { listHctAssets } = await import('../hct/wallet')
  const self = active.identityKey.toLowerCase()
  const assets = (await listHctAssets()).assets
  const holding = (a: (typeof assets)[number] | undefined): WltcHolding | null =>
    a ? { assetId: a.assetId, balance: BigInt(a.balance), locked: BigInt(a.locked ?? '0') } : null
  const ours = (a: (typeof assets)[number]) => a.mode === 'open' && a.kind === 'token' && a.sym === WLTC_SYM && a.authority && a.issuers.includes(self)
  const backed = state.backedAssetId
    ? assets.find((a) => a.assetId === state.backedAssetId)
    : assets.find((a) => ours(a) && a.backedBy === 'ltc')
  const legacy = state.assetId ? assets.find((a) => a.assetId === state.assetId) : assets.find((a) => ours(a) && !a.backedBy)
  return { backed: holding(backed), legacy: holding(legacy) }
}

async function backedAssetId(active: ActiveWallet, state: WltcState): Promise<string | null> {
  return state.backedAssetId ?? (await wltcHoldings(active, state)).backed?.assetId ?? null
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
  writeState({ ...state, expectUntil: Date.now() + EXPECT_DEPOSIT_MS })
  return {
    network: 'litecoin',
    address: reserveOf(active).address,
    asset: WLTC_SYM,
    assetId: await backedAssetId(active, state),
    decimals: WLTC_DECIMALS,
    minConfirmations: LTC_BURIAL_DEPTH,
  }
}

// ── Credit ─────────────────────────────────────────────────────────────────

/**
 * `credited`: wLTC minted. `proven` false means it cannot move yet; it moves
 * once the deposit has `needed` confirmations. `waiting`: not minted yet,
 * because the first deposit (whose deploy is the mint authority) is unproven.
 * `void`: the deposit vanished before it was proven; its wLTC never moves.
 */
export type LtcDepositStatus =
  | {
      txid: string
      vout: number
      litoshi: string
      status: 'credited'
      proven: boolean
      bsvTxid?: string
      /** Counted on this wallet's own Litecoin chain; 0 until it has counted any. */
      confirmations?: number
      needed?: number
      phase?: LtcDepositPhase
    }
  | { txid: string; vout: number; litoshi: string; status: 'waiting'; needed: number }
  | { txid: string; vout: number; litoshi: string; status: 'void'; bsvTxid?: string }
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
  /** Of `balance`, wLTC waiting for its deposit's burial proof. */
  locked: string
  deposits: LtcDepositStatus[]
  withdrawals: LtcWithdrawalStatus[]
}

/** Mints this session wrote or saw committed to the HCT store. */
const committedMints = new Set<string>()

/**
 * Mint one deposit against the backed wLTC, naming it in a backing output so
 * every receiver can demand its burial proof. The label names the outpoint
 * so a restored wallet finds the mint instead of minting again.
 */
async function mintDeposit(active: ActiveWallet, txid: string, vout: number, litoshi: bigint): Promise<string> {
  const key = outpointKey(txid, vout)
  const label = `${DEPOSIT_LABEL} ${txid}.${vout}`
  let state = readState()
  const prior = state.deposits[key]
  if (prior?.status === 'credited' && prior.bsvTxid) return prior.bsvTxid
  const recorded = prior ? await labelledAction(active, label) : null
  if (recorded) {
    state.deposits[key] = { ...prior!, status: 'credited', bsvTxid: recorded, proven: prior!.proven ?? false }
    writeState(state)
    return recorded
  }
  state.deposits[key] = { litoshi: litoshi.toString(), status: 'minting', at: Date.now(), proven: false }
  writeState(state)
  const hct = await import('../hct/wallet')
  const assetId = await backedAssetId(active, state)
  const labels = [label]
  const deposit = { txid, vout }
  let bsvTxid: string
  if (assetId) {
    bsvTxid = (await hct.mintHctAsset({ assetId, amount: litoshi.toString() }, { labels, backing: { deposit } })).txid
  } else {
    const issued = await hct.issueHctAsset(
      { kind: 'token', sym: WLTC_SYM, name: 'Wrapped Litecoin', dec: WLTC_DECIMALS, supply: litoshi.toString(), auth: true },
      { labels, backing: { deposit, bk: { chain: 'ltc', reserve: reserveOf(active).scriptHex } } },
    )
    bsvTxid = issued.txid
    state = readState()
    state.backedAssetId = issued.assetId
    writeState(state)
  }
  committedMints.add(bsvTxid)
  state = readState()
  if (!state.backedAssetId && assetId) state.backedAssetId = assetId
  state.deposits[key] = { litoshi: litoshi.toString(), status: 'credited', bsvTxid, at: Date.now(), proven: false }
  writeState(state)
  return bsvTxid
}

/**
 * Every credit must name a signed mint the HCT store holds. Before 1.3.602 a
 * mint interrupted while still unsigned counted as credited without a txid;
 * such a credit is dropped so the deposit mints again. A signed mint the app
 * stopped before committing is adopted.
 */
async function healCredits(active: ActiveWallet): Promise<void> {
  const { adoptSignedHctAction } = await import('../hct/wallet')
  for (const [key, d] of Object.entries(readState().deposits)) {
    if (d.status !== 'credited' || (d.bsvTxid && committedMints.has(d.bsvTxid))) continue
    const [txid, vout] = key.split(':') as [string, string]
    const minted = d.bsvTxid ?? (await labelledAction(active, `${DEPOSIT_LABEL} ${txid}.${vout}`))
    if (!minted) {
      const state = readState()
      delete state.deposits[key]
      writeState(state)
      console.warn(`[wltc] credit ${key} had no signed mint — minting again`)
      continue
    }
    try {
      await adoptSignedHctAction(minted)
      committedMints.add(minted)
      if (!d.bsvTxid) {
        const state = readState()
        const record = state.deposits[key]
        if (record) record.bsvTxid = minted
        writeState(state)
      }
    } catch (err) {
      console.warn(`[wltc] mint ${minted.slice(0, 12)} of ${key} not adopted — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** New deposits paying the reserve: minted at first sight, or `waiting` while the first deposit is unproven. */
async function creditPass(active: ActiveWallet, utxos: Awaited<ReturnType<LtcChain['addressUtxos']>>): Promise<LtcDepositStatus[]> {
  const { script } = reserveOf(active)
  const state = readState()
  const ownChange = new Set(
    Object.entries(state.withdrawals).flatMap(([txid, w]) => (w.change ? [outpointKey(txid, w.change.vout)] : [])),
  )
  const statuses: LtcDepositStatus[] = []
  for (const utxo of utxos) {
    const key = outpointKey(utxo.txid, utxo.vout)
    if (ownChange.has(key) || state.deposits[key]?.status === 'credited') continue
    const chart = createActor(wltcMachine).start()
    chart.send({ type: 'CREDIT' })
    try {
      const sighting = await readLtcDeposit(deps.chain, { txid: utxo.txid, vout: utxo.vout }, script)
      if (sighting.kind === 'refuse') {
        chart.send({ type: 'REFUSED', error: sighting.reason })
        statuses.push({ txid: utxo.txid, vout: utxo.vout, status: 'refused', reason: sighting.reason, detail: sighting.detail })
        continue
      }
      chart.send({ type: 'SEEN' })
      const startedAt = Date.now()
      let bsvTxid: string
      try {
        bsvTxid = await mintDeposit(active, utxo.txid, utxo.vout, sighting.litoshi)
      } catch (err) {
        const { HctRefusal } = await import('../hct/wallet')
        if (!(err instanceof HctRefusal && err.reason === 'awaiting-backing')) throw err
        const dropped = readState()
        if (dropped.deposits[key]?.status === 'minting') delete dropped.deposits[key]
        writeState(dropped)
        chart.send({ type: 'AWAITING' })
        statuses.push({ txid: utxo.txid, vout: utxo.vout, litoshi: sighting.litoshi.toString(), status: 'waiting', needed: LTC_BURIAL_DEPTH })
        continue
      }
      chart.send({ type: 'MINTED', bsvTxid })
      const ms = Date.now() - startedAt
      if (ms > 250) console.info(`[wltc] mint done ${ms}ms`)
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'wltc-credit',
        note: `Credited ${formatLtc(sighting.litoshi)} wLTC for LTC deposit ${utxo.txid.slice(0, 12)}… (moves after ${LTC_BURIAL_DEPTH} Litecoin confirmations)`,
        txid: bsvTxid,
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

/**
 * A deposit proven before 1.3.604 holds a header-run proof that no wallet
 * reads now (burials are anchored to each reader's own Litecoin chain).
 * Its wLTC is locked again until the anchored proof is fetched.
 */
async function reopenUnreadableProofs(): Promise<void> {
  const { getHctBacking } = await import('../hct/store')
  const state = readState()
  let changed = false
  for (const [key, d] of Object.entries(state.deposits)) {
    if (d.status !== 'credited' || d.proven !== true || !d.bsvTxid) continue
    if (await getHctBacking(d.bsvTxid)) continue
    d.proven = false
    changed = true
    console.info(`[wltc] proof of ${key} is in the old header-run form — fetching the anchored proof`)
  }
  if (changed) writeState(state)
}

type Judgement = {
  phase: LtcDepositPhase
  /** The proof to keep for the next check; null drops the kept one. */
  proof?: LtcBurialProof | null
  /** Set when the deposit is buried: the proof to record. */
  buried?: LtcBurialProof
  /** When the explorers stopped knowing it; null clears it. */
  goneAt?: number | null
}

function uncheckedSince(d: DepositRecord, now: number): LtcDepositPhase {
  const prior = d.phase
  const last =
    prior?.kind === 'confirming'
      ? { confirmations: prior.confirmations, needed: prior.needed, height: prior.height, checkedAt: prior.checkedAt }
      : prior?.kind === 'unchecked'
        ? prior.last
        : undefined
  return { kind: 'unchecked', since: prior?.kind === 'unchecked' ? prior.since : now, ...(last ? { last } : {}) }
}

/**
 * Where an unproven deposit stands. Depth is only ever this wallet's own
 * header chain's answer (`checkLtcBurial`); an explorer only says whether the
 * deposit waits for a block or which block holds it. A kept proof needs no
 * explorer at all. A kept proof the chain no longer holds (reorganized) is
 * dropped and the deposit located again.
 */
async function judgeDeposit(d: DepositRecord, outpoint: { txid: string; vout: number }, reserve: Uint8Array, fresh = false): Promise<Judgement> {
  const now = Date.now()
  let proof = fresh ? undefined : d.proof
  const kept = !!proof
  if (!proof) {
    let located
    try {
      located = await locateLtcDeposit(deps.chain, outpoint.txid)
    } catch (err) {
      console.warn(`[wltc] locate ${outpoint.txid.slice(0, 12)} failed — ${err instanceof Error ? err.message : String(err)}`)
      return { phase: uncheckedSince(d, now) }
    }
    if (located.kind === 'gone') {
      const since = d.goneAt ?? now
      return { phase: { kind: now - since >= VOID_AFTER_MS ? 'abandoned' : 'missing', since }, goneAt: since, proof: null }
    }
    if (located.kind === 'unconfirmed') return { phase: { kind: 'unconfirmed', checkedAt: now }, goneAt: null, proof: null }
    proof = located.proof
  }
  const check = await checkLtcBurial(proof, outpoint, reserve, BigInt(d.litoshi))
  if (check.ok) return { phase: { kind: 'movable', height: proof.height, checkedAt: now }, buried: proof, proof: null, goneAt: null }
  if (check.reason === 'shallow') {
    return {
      phase: { kind: 'confirming', confirmations: check.confirmations ?? 0, needed: LTC_BURIAL_DEPTH, height: proof.height, checkedAt: now },
      proof,
      goneAt: null,
    }
  }
  if (check.reason === 'unanchored') return { phase: uncheckedSince(d, now), proof }
  console.warn(`[wltc] proof of ${outpoint.txid.slice(0, 12)} refused (${check.reason}) — ${check.detail}`)
  if (kept) return judgeDeposit({ ...d, proof: undefined }, outpoint, reserve, true)
  return { phase: uncheckedSince(d, now), proof: null }
}

/**
 * Unproven deposits: count each one's confirmations on this wallet's own
 * Litecoin chain, and once buried record its proof, which frees its wLTC.
 * `skipAbandoned` leaves deposits already abandoned alone (the watcher).
 */
async function provePass(active: ActiveWallet, opts: { skipAbandoned?: boolean } = {}): Promise<void> {
  await reopenUnreadableProofs()
  const state = readState()
  const assetId = await backedAssetId(active, state)
  const { script: reserve } = reserveOf(active)
  for (const [key, d] of Object.entries(state.deposits)) {
    if (d.status !== 'credited' || d.proven !== false || !d.bsvTxid || !assetId) continue
    if (opts.skipAbandoned && d.phase?.kind === 'abandoned') continue
    const [txid, vout] = key.split(':') as [string, string]
    const chart = createActor(wltcMachine).start()
    chart.send({ type: 'PROVE' })
    try {
      const startedAt = Date.now()
      const judged = await judgeDeposit(d, { txid, vout: Number(vout) }, reserve)
      const next = readState()
      const record = next.deposits[key]
      if (!record) continue
      record.phase = judged.phase
      if (judged.proof === null) delete record.proof
      else if (judged.proof) record.proof = judged.proof
      if (judged.goneAt === null) delete record.goneAt
      else if (judged.goneAt !== undefined) record.goneAt = judged.goneAt
      if (!judged.buried) {
        writeState(next)
        chart.send({ type: judged.phase.kind === 'abandoned' ? 'VOIDED' : 'PENDING' })
        continue
      }
      const { proveHctBacking } = await import('../hct/wallet')
      await proveHctBacking(assetId, d.bsvTxid, judged.buried)
      record.proven = true
      writeState(next)
      chart.send({ type: 'PROVEN' })
      const ms = Date.now() - startedAt
      if (ms > 250) console.info(`[wltc] prove done ${ms}ms`)
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'wltc-proven',
        note: `${formatLtc(BigInt(d.litoshi))} wLTC can move: LTC deposit ${txid.slice(0, 12)}…:${vout} has ${LTC_BURIAL_DEPTH} Litecoin confirmations`,
        txid: d.bsvTxid,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      chart.send({ type: 'FAIL', error })
      console.warn(`[wltc] proof ${key} deferred — ${error}`)
    } finally {
      chart.stop()
    }
  }
}

/** A deposit's phase as the record holds it; deposits credited before 1.3.601, or already proven, can move. */
function phaseOf(d: DepositRecord): LtcDepositPhase {
  if (d.proven !== false) return d.phase?.kind === 'movable' ? d.phase : { kind: 'movable' }
  return d.phase ?? { kind: 'unchecked', since: d.at }
}

function report(
  active: ActiveWallet,
  assetId: string | null,
  holdings: { backed: WltcHolding | null; legacy: WltcHolding | null },
  live: LtcDepositStatus[],
): LtcDepositsResult {
  const state = readState()
  const credited: LtcDepositStatus[] = Object.entries(state.deposits)
    .filter(([, d]) => d.status === 'credited')
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([key, d]): LtcDepositStatus => {
      const [txid, vout] = key.split(':')
      const base = { txid: txid!, vout: Number(vout), litoshi: d.litoshi, ...(d.bsvTxid ? { bsvTxid: d.bsvTxid } : {}) }
      const phase = phaseOf(d)
      if (phase.kind === 'abandoned') return { ...base, status: 'void' }
      const confirming = phase.kind === 'confirming' ? phase.confirmations : 0
      return {
        ...base,
        status: 'credited',
        proven: d.proven !== false,
        ...(d.proven === false ? { confirmations: confirming, needed: LTC_BURIAL_DEPTH, phase } : {}),
      }
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
  const held = [holdings.backed, holdings.legacy].filter((h): h is WltcHolding => !!h)
  return {
    address: reserveOf(active).address,
    assetId,
    balance: held.reduce((sum, h) => sum + h.balance, 0n).toString(),
    locked: held.reduce((sum, h) => sum + h.locked, 0n).toString(),
    deposits: [...live, ...credited],
    withdrawals,
  }
}

/**
 * Every deposit to the reserve address and what became of it. A deposit seen
 * paying the reserve is minted as wLTC to this wallet during the call, and
 * its burial proof is recorded once it is deep enough: minting against an LTC
 * output paying this wallet's own reserve is receiving, and an app cannot
 * cause one without a real deposit.
 */
export function listLtcDeposits(): Promise<LtcDepositsResult> {
  return serial(async () => {
    const active = requireActive()
    await settleWithdrawals(active)
    await healCredits(active)
    const utxos = await deps.chain.addressUtxos(reserveOf(active).address)
    const live = await creditPass(active, utxos)
    await provePass(active)
    const state = readState()
    return report(active, await backedAssetId(active, state), await wltcHoldings(active, state), live)
  })
}

/** Every credited deposit of the open account, newest first, as the record holds it. No network. */
export function readLtcDepositViews(): LtcDepositView[] {
  if (!getWalletRuntime()?.instance) return []
  const state = readState()
  return Object.entries(state.deposits)
    .filter(([, d]) => d.status === 'credited')
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([key, d]) => {
      const [txid, vout] = key.split(':') as [string, string]
      const assetId = d.proven === undefined ? state.assetId : state.backedAssetId
      return {
        txid,
        vout: Number(vout),
        litoshi: d.litoshi,
        at: d.at,
        phase: phaseOf(d),
        ...(d.bsvTxid ? { bsvTxid: d.bsvTxid } : {}),
        ...(assetId ? { assetId } : {}),
      }
    })
}

/** About one check per Litecoin block (2.5 min) is enough; more would only repeat the same answer. */
const WATCH_MS = 60_000
let watchTimer: ReturnType<typeof setInterval> | null = null

/** How long after the deposit address is handed out the watcher looks for a new deposit. */
export const EXPECT_DEPOSIT_MS = 2 * 60 * 60_000

function hasWaitingDeposit(state: WltcState): boolean {
  return Object.values(state.deposits).some((d) => d.status === 'credited' && d.proven === false && d.phase?.kind !== 'abandoned')
}

/**
 * One watcher pass. `scanned`: the deposit address was read for new deposits
 * (only while expecting one) and waiting ones counted. `counted`: only waiting
 * deposits were counted, on the wallet's own chain once each has its proof.
 * `idle`: nothing waits, no deposit is expected, so nothing touched the network.
 */
export async function watchLtcDeposits(): Promise<'idle' | 'counted' | 'scanned'> {
  const active = getWalletRuntime()?.instance
  if (!active) return 'idle'
  const state = readState()
  const expecting = (state.expectUntil ?? 0) > Date.now()
  if (!expecting && !hasWaitingDeposit(state)) return 'idle'
  return serial(async () => {
    if (expecting) {
      await healCredits(active)
      await creditPass(active, await deps.chain.addressUtxos(reserveOf(active).address))
    }
    await provePass(active, { skipAbandoned: true })
    return expecting ? 'scanned' : 'counted'
  })
}

/**
 * While the wallet is open, run {@link watchLtcDeposits} about once a minute
 * so activity and collections move without an app polling, and a deposit
 * sent after the deposit page closed still appears. Paused while the page is
 * hidden.
 */
export function startWltcWatcher(): void {
  if (watchTimer) return
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    void watchLtcDeposits().catch((err: unknown) => {
      console.warn(`[wltc] watch pass failed — ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  watchTimer = setInterval(tick, WATCH_MS)
  setTimeout(tick, 5_000)
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

/** Proven reserve outputs with the amounts this wallet recorded (never the explorer's). */
function backedOutputs(state: WltcState, unspent: ReadonlySet<string>): Array<{ txid: string; vout: number; litoshi: bigint }> {
  const reserved = new Set(
    Object.values(state.withdrawals)
      .filter((w) => w.status !== 'sent')
      .flatMap((w) => w.inputs),
  )
  const out: Array<{ txid: string; vout: number; litoshi: bigint }> = []
  for (const [key, d] of Object.entries(state.deposits)) {
    if (!isProven(d) || reserved.has(key) || !unspent.has(key)) continue
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
      const holdings = await wltcHoldings(active, state)
      if (!holdings.backed && !holdings.legacy) refuse('no-asset', 'This wallet has not minted any wLTC yet.')
      const reserve = reserveOf(active)
      const unspent = new Set((await deps.chain.addressUtxos(reserve.address)).map((u) => outpointKey(u.txid, u.vout)))
      const plan = planLtcWithdrawal(backedOutputs(state, unspent), destination, reserve.script, litoshi, await deps.chain.feeRate())
      if (!plan) refuse('reserve-short', `The reserve cannot pay ${formatLtc(litoshi)} LTC plus its fee from credited deposits.`)
      const movable = [holdings.legacy, holdings.backed].filter((h): h is WltcHolding => !!h).map((h) => ({ ...h, movable: h.balance - h.locked }))
      const source = movable.find((h) => h.movable >= plan.burn)
      if (!source) {
        const best = movable.reduce((max, h) => (h.movable > max ? h.movable : max), 0n)
        refuse('insufficient', `Withdrawing ${formatLtc(litoshi)} LTC burns ${formatLtc(plan.burn)} wLTC with the fee; this wallet can move ${formatLtc(best)} in one wLTC asset.`)
      }
      const assetId = source.assetId
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
            { assetId, amount: plan.burn, holder: WLTC_BURN_HOLDER, memo: `wltc-redeem ${ltcTxid}` },
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

