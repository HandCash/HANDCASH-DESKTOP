import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { createActor } from 'xstate'
import { coinMachine } from '../../machines/coinMachine'
import { accountLocalKey } from '../accountLocalKeys'
import { appendCustody, unspentCoinCustody } from '../custodyJournal'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN, type ActivityItem } from '../appActivity'
import { durableGetItem, durableSetItem } from '../durableStorage'
import type { LtcChain } from '../ltc/chain'
import { depositCount, type CoinDepositPhase, type CoinDepositView } from './depositPhase'
import { fromHex, ltcTxid, sameBytes, toHex, type LtcTx } from '../ltc/litecoin'
import { checkLtcBurial, locateLtcDeposit, readLtcDeposit, type CoinProofRules, type LtcBurialProof } from '../ltc/verify'
import { assertOnlineForPayment } from '../paymentPolicy'
import type { CoinChain } from './coinChains'
import type { ActiveWallet } from '../session'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { getWalletRuntime } from '../walletRuntime'

/**
 * A native coin on a UTXO chain (BRC-213). The wallet holds its own key on the
 * chain and its balance is the outputs paying that key. Nothing is wrapped,
 * minted or burned: value only ever moves on its own chain, so nobody holds a
 * claim another party must honour.
 *
 * Received coins are spendable once this wallet's own header chain for the
 * coin counts `depth` confirmations over their block; change is spendable once
 * the payment that made it has been broadcast. Sources are untrusted: amounts
 * come from raw transactions this wallet checked, and depth only from its own
 * header chain.
 *
 * Everything chain-specific (addresses, scripts, signing, sizes, sources,
 * header rules) is the coin's {@link CoinBinding}; this engine is the same for
 * every chain.
 */

export type CoinChainId = CoinChain

export type CoinBinding = {
  chain: CoinChainId
  /** "Litecoin". */
  label: string
  /** "LTC". */
  ticker: string
  decimals: number
  /** Smallest output a payment pays or keeps as change, in the smallest unit. */
  dust: bigint
  /** When a payment lands: its first block. */
  paymentEta: string
  /** The open account's record (`storageRegistry.<coin>.key`). */
  storageKey: string
  keyProtocol: [2, string]
  keyId: string
  /** BRC-42 protocol of the key a payment to this wallet's identity is locked to (BRC-213 §7): the sender's key is the counterparty. */
  paymentProtocol: [2, string]
  /** Activity methods of received and sent coins. */
  activity: { receive: string; send: string }
  proof: CoinProofRules
  defaultSource(): LtcChain
  address(pubkey: Uint8Array): string
  script(pubkey: Uint8Array): Uint8Array
  /** The script a payment to `address` locks; throws unless it is an address this coin pays. */
  outputScript(address: string): Uint8Array
  /** `keys`: the key each input's coin pays, one per input. */
  sign(tx: LtcTx, keys: readonly PrivateKey[], amounts: readonly bigint[]): LtcTx
  /** The bytes broadcast. */
  serialize(tx: LtcTx): Uint8Array
  txid(tx: LtcTx): string
  /** Sizes the fee is paid on: bytes, or virtual bytes where the chain discounts witness data. */
  size: { overhead: number; input: number }
  /** Input sequence: Litecoin signals replace-by-fee, Bitcoin Cash has none. */
  sequence: number
  format(units: bigint): string
  /** Run before the open account's record is read: Litecoin carries the earlier wLTC record over. */
  migrate?(store: CoinStore): void
}

export class CoinRefusalError extends Error {
  constructor(
    readonly chain: CoinChainId,
    readonly reason: 'bad-args' | 'own-address' | 'insufficient' | 'held-elsewhere' | 'unsupported-recipient' | 'recipient-unchecked',
    message: string,
  ) {
    super(message)
    this.name = 'CoinRefusalError'
  }
}

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Amounts are in the coin's smallest unit (litoshi, satoshis). The field is
 * named `litoshi` because Litecoin records were written first; renaming it
 * would strand them.
 */
export type Coin = {
  litoshi: string
  at: number
  /** `received`: paid to this wallet by anyone. `change`: this wallet's own payment returning to it. */
  source: 'received' | 'change'
  /** Received coins only: buried `depth` deep on this wallet's own chain. */
  proven?: true
  phase?: CoinDepositPhase
  /** Burial proof built from a source's answer, kept while too shallow, so later checks need only this wallet's chain. */
  proof?: LtcBurialProof
  /** When the sources first stopped knowing it. */
  goneAt?: number
  /** Paid to this wallet's identity: locked to the key derived for `sender` under `keyId` (BRC-213 §7). Absent: the wallet's own key. */
  paidBy?: CoinSender
}

export type CoinSender = { sender: string; keyId: string }

/** The notice a payment to an identity owes its recipient (BRC-213 §7). Delivery never gates the payment. */
export type CoinNotice = {
  delivered?: true
  attempts: number
  nextAt?: number
  lastError?: string
}

export type Payment = {
  address: string
  litoshi: string
  fee: string
  hex: string
  /** `txid:vout` of each coin it spends. */
  inputs: string[]
  change?: { vout: number; litoshi: string }
  /** Paid to an identity: `address` is the key derived for it under `keyId`, at output `vout`. */
  to?: { identityKey: string; keyId: string; vout: number; notice: CoinNotice }
  /** Locks a swap's hash-locked outputs (outputs `0..n-1`); `address` is the first lock's. */
  lock?: { swapId: string }
  status: 'signed' | 'sent'
  /** In a block; until then a sent payment is re-broadcast whenever the network has lost it. */
  confirmed?: true
  at: number
  attempts: number
  lastError?: string
}

export type CoinState = {
  coins: Record<string, Coin>
  payments: Record<string, Payment>
  /** Until when the watcher reads the address for new coins: set each time the address is handed out. */
  expectUntil?: number
  /** When this install first read the address, so coins held before a restore or on another install still appear. */
  discoveredAt?: number
  /** The earlier wLTC record has been carried over (Litecoin only). */
  migrated?: true
}

export type CoinStore = { read(): CoinState; write(state: CoinState): void }

export type CoinBalance = {
  /** Smallest units this wallet can spend now. */
  spendable: string
  /** Smallest units received and still confirming. */
  confirming: string
}

export type CoinPaymentPlan = {
  tx: LtcTx
  amounts: bigint[]
  inputs: string[]
  fee: bigint
  change?: { vout: number; litoshi: bigint }
}

export type CoinStatus = { txid: string; vout: number; litoshi: string; source: Coin['source']; phase: CoinDepositPhase; spent: boolean }
export type CoinPaymentStatus = {
  ltcTxid: string
  address: string
  litoshi: string
  fee: string
  status: 'signed' | 'sent'
  confirmed: boolean
  lastError?: string
  /** Paid to an identity; `notified` once its notice reached the recipient's box. */
  to?: { identityKey: string; notified: boolean }
}
export type CoinWalletReport = { address: string; balance: CoinBalance; coins: CoinStatus[]; payments: CoinPaymentStatus[] }
/** A payment names an address on the chain, or an identity (BRC-213 §7). */
export type SendCoinArgs = { address?: unknown; identityKey?: unknown; litoshi?: unknown }
type Destination = { address: string; script: Uint8Array; to?: { identityKey: string; keyId: string } }
/** Where a swap lock stands on this wallet's own chain. `unchecked`: could not be read now; try again. */
export type LockSighting =
  | { kind: 'buried' }
  | { kind: 'confirming'; confirmations: number; needed: number }
  | { kind: 'unconfirmed' }
  | { kind: 'gone' }
  | { kind: 'unchecked'; detail: string }
  | { kind: 'refused'; reason: string; detail: string }

export type SendCoinResult = { ltcTxid: string; litoshi: string; fee: string; status: 'sent' | 'queued' }

export type CoinAppCoin = {
  txid: string
  vout: number
  litoshi: string
  status: 'credited' | 'void'
  proven: boolean
  confirmations?: number
  needed: number
}
export type CoinAppReport = {
  address: string
  /** Received and not spent, spendable or still confirming. */
  balance: string
  /** Of `balance`, still confirming. */
  locked: string
  deposits: CoinAppCoin[]
  withdrawals: CoinPaymentStatus[]
}

const outpointKey = (txid: string, vout: number) => `${txid}:${vout}`
const VOID_AFTER_MS = 30 * 60_000
const MAX_INPUTS = 50
const outputBytes = (script: Uint8Array) => 9 + script.length
/** The box a payment to an identity is announced in (BRC-213 §7). */
export const COIN_PAYMENT_BOX = 'coin-payment'
export type CoinPaymentNotice = { v: 1; t: 'coin-payment'; chain: CoinChainId; txid: string; vout: number; keyId: string }
const NOTICE_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]
const KEY_ID = /^[0-9a-f]{32}$/
const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/
/** How long after the address is handed out the watcher reads it for new coins. */
export const EXPECT_COINS_MS = 2 * 60 * 60_000
const WATCH_MS = 60_000
/** Outside the expect window the address is still read this often, so a payment arriving unannounced appears. */
const IDLE_SCAN_MS = 5 * 60_000

/**
 * Choose coins, largest first, and build the unsigned payment. A remainder
 * too small to keep as change goes to the fee.
 */
export function planCoinPayment(
  binding: Pick<CoinBinding, 'dust' | 'size' | 'sequence'>,
  coins: ReadonlyArray<{ txid: string; vout: number; litoshi: bigint }>,
  destination: Uint8Array,
  changeScript: Uint8Array,
  amount: bigint,
  feeRate: number,
): CoinPaymentPlan | null {
  return planCoinOutputs(binding, coins, [{ script: destination, value: amount }], changeScript, feeRate)
}

/** {@link planCoinPayment} to several outputs, in order; change, when kept, follows them. */
export function planCoinOutputs(
  binding: Pick<CoinBinding, 'dust' | 'size' | 'sequence'>,
  coins: ReadonlyArray<{ txid: string; vout: number; litoshi: bigint }>,
  outputs: ReadonlyArray<{ script: Uint8Array; value: bigint }>,
  changeScript: Uint8Array,
  feeRate: number,
): CoinPaymentPlan | null {
  if (outputs.length === 0) return null
  const rate = BigInt(Math.max(1, Math.ceil(feeRate)))
  const amount = outputs.reduce((sum, o) => sum + o.value, 0n)
  const outBytes = outputs.reduce((sum, o) => sum + outputBytes(o.script), 0)
  const chosen: (typeof coins)[number][] = []
  let sum = 0n
  for (const coin of coins) {
    if (chosen.length >= MAX_INPUTS) break
    chosen.push(coin)
    sum += coin.litoshi
    const base = binding.size.overhead + binding.size.input * chosen.length + outBytes
    const feeWithChange = rate * BigInt(base + outputBytes(changeScript))
    const feeNoChange = rate * BigInt(base)
    const tx = (extra: LtcTx['outputs']): LtcTx => ({
      version: 2,
      inputs: chosen.map((c) => ({ txid: c.txid, vout: c.vout, script: new Uint8Array(), sequence: binding.sequence, witness: [] })),
      outputs: [...outputs.map((o) => ({ value: o.value, script: o.script })), ...extra],
      locktime: 0,
    })
    const inputs = chosen.map((c) => outpointKey(c.txid, c.vout))
    const amounts = chosen.map((c) => c.litoshi)
    if (sum >= amount + feeWithChange + binding.dust) {
      const changeValue = sum - amount - feeWithChange
      return {
        tx: tx([{ value: changeValue, script: changeScript }]),
        amounts,
        inputs,
        fee: feeWithChange,
        change: { vout: outputs.length, litoshi: changeValue },
      }
    }
    if (sum >= amount + feeNoChange) return { tx: tx([]), amounts, inputs, fee: sum - amount }
  }
  return null
}

export function createCoinWallet(binding: CoinBinding) {
  const { chain, label, ticker, proof: proofRules } = binding
  const tag = chain
  const fmt = (units: bigint) => `${binding.format(units)} ${ticker}`

  function refuse(reason: CoinRefusalError['reason'], message: string): never {
    console.warn(`[${tag}] refuse ${reason} — ${message}`)
    throw new CoinRefusalError(chain, reason, message)
  }

  const coinKey = (root: PrivateKey): PrivateKey => new KeyDeriver(root).derivePrivateKey(binding.keyProtocol, binding.keyId, 'self')

  // ── State ────────────────────────────────────────────────────────────────

  const stateKey = () => accountLocalKey(binding.storageKey)

  function readState(): CoinState {
    try {
      const parsed = JSON.parse(durableGetItem(stateKey()) ?? '{}') as Partial<CoinState>
      return {
        coins: parsed.coins ?? {},
        payments: parsed.payments ?? {},
        ...(typeof parsed.expectUntil === 'number' ? { expectUntil: parsed.expectUntil } : {}),
        ...(typeof parsed.discoveredAt === 'number' ? { discoveredAt: parsed.discoveredAt } : {}),
        ...(parsed.migrated ? { migrated: true as const } : {}),
      }
    } catch {
      return { coins: {}, payments: {} }
    }
  }

  const listeners = new Set<() => void>()

  function writeState(state: CoinState): void {
    const json = JSON.stringify(state)
    if (json === durableGetItem(stateKey())) return
    if (!durableSetItem(stateKey(), json)) throw new Error(`The ${label} record could not be saved.`)
    for (const listener of listeners) listener()
  }

  const store: CoinStore = { read: readState, write: writeState }

  function migrate(): void {
    if (binding.migrate && getWalletRuntime()?.instance) binding.migrate(store)
  }

  // ── Runtime ──────────────────────────────────────────────────────────────

  let source: LtcChain | null = null
  const src = () => (source ??= binding.defaultSource())

  function requireActive(): ActiveWallet {
    const active = getWalletRuntime()?.instance ?? null
    if (!active) throw new Error('Wallet locked')
    return active
  }

  type CoinKey = { key: PrivateKey; address: string; script: Uint8Array }

  function keyed(key: PrivateKey): CoinKey {
    const pub = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    return { key, address: binding.address(pub), script: binding.script(pub) }
  }

  function keyOf(active: ActiveWallet): CoinKey {
    return keyed(coinKey(PrivateKey.fromHex(active.rootKeyHex)))
  }

  /** The key a payment from `paidBy.sender` was locked to: the BRC-42 child the sender derived for this identity. */
  function paidKeyOf(active: ActiveWallet, paidBy: CoinSender): CoinKey {
    return keyed(new KeyDeriver(PrivateKey.fromHex(active.rootKeyHex)).derivePrivateKey(binding.paymentProtocol, paidBy.keyId, paidBy.sender))
  }

  const coinKeyOf = (active: ActiveWallet, coin: Coin): CoinKey => (coin.paidBy ? paidKeyOf(active, coin.paidBy) : keyOf(active))

  // A coin paid to this identity is spendable only with its sender and key id,
  // which the account root cannot regenerate. The custody journal carries them
  // off the device with the wallet's other spend recipes.
  const ownerOf = (active: ActiveWallet) => ({ identityKey: active.identityKey, accountIndex: active.accountIndex ?? 0, chain: active.chain })
  const custodyOp = (key: string) => key.replace(':', '.')

  function journalPaidCoin(active: ActiveWallet, key: string, units: bigint, paidBy: CoinSender): void {
    const { ok } = appendCustody(ownerOf(active), [
      { k: 'out', op: custodyOp(key), sats: Number(units), r: { p: 'coin payment', chain, sender: paidBy.sender, keyId: paidBy.keyId } },
    ])
    if (!ok) throw new Error(`The custody journal refused the recipe of ${key}.`)
  }

  let tail: Promise<unknown> = Promise.resolve()

  /** Reads and payments run one at a time, so no coin is recorded or spent twice in flight. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }

  const activityItem = (units: bigint): ActivityItem => ({ name: ticker, origin: chain, amt: units.toString(), dec: binding.decimals, backedBy: chain })

  // ── Balance ──────────────────────────────────────────────────────────────

  const spentKeys = (state: CoinState) => new Set(Object.values(state.payments).flatMap((p) => p.inputs))

  /** A coin this wallet may spend now: a buried received coin, or change from its own broadcast payment. */
  function spendable(state: CoinState, key: string, coin: Coin): boolean {
    if (coin.source === 'received') return coin.proven === true
    return state.payments[key.split(':')[0]!]?.status === 'sent'
  }

  function balanceOf(state: CoinState): { spendable: bigint; confirming: bigint } {
    const spent = spentKeys(state)
    let ready = 0n
    let waiting = 0n
    for (const [key, coin] of Object.entries(state.coins)) {
      if (spent.has(key)) continue
      if (spendable(state, key, coin)) ready += BigInt(coin.litoshi)
      else if (coin.source === 'received' && coin.phase?.kind !== 'abandoned') waiting += BigInt(coin.litoshi)
    }
    return { spendable: ready, confirming: waiting }
  }

  function readBalance(): CoinBalance {
    if (!getWalletRuntime()?.instance) return { spendable: '0', confirming: '0' }
    const b = balanceOf(readState())
    return { spendable: b.spendable.toString(), confirming: b.confirming.toString() }
  }

  function getAddress(): string {
    const active = requireActive()
    migrate()
    writeState({ ...readState(), expectUntil: Date.now() + EXPECT_COINS_MS })
    return keyOf(active).address
  }

  // ── Receive ──────────────────────────────────────────────────────────────

  /** Outputs paying this wallet that it has not recorded: each checked against its raw transaction, then recorded as received. */
  async function receivePass(active: ActiveWallet): Promise<void> {
    const { address, script } = keyOf(active)
    const utxos = await src().addressUtxos(address)
    for (const utxo of utxos) {
      const key = outpointKey(utxo.txid, utxo.vout)
      if (readState().coins[key]) continue
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'RECEIVE' })
      try {
        const sighting = await readLtcDeposit(src(), { txid: utxo.txid, vout: utxo.vout }, script, proofRules)
        if (sighting.kind === 'refuse') {
          chart.send({ type: 'REFUSED', error: sighting.reason })
          console.warn(`[${tag}] ${key} refused (${sighting.reason}) — ${sighting.detail}`)
          continue
        }
        const next = readState()
        if (next.coins[key]) continue
        next.coins[key] = { litoshi: sighting.litoshi.toString(), at: Date.now(), source: 'received' }
        writeState(next)
        chart.send({ type: 'SEEN' })
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'earned',
          sats: 0,
          method: binding.activity.receive,
          note: `${label} ${key}`,
          txid: utxo.txid,
          item: activityItem(sighting.litoshi),
        })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        chart.send({ type: 'FAIL', error })
        console.warn(`[${tag}] read ${key} failed — ${error}`)
      } finally {
        chart.stop()
      }
    }
  }

  // ── Prove ────────────────────────────────────────────────────────────────

  type Judgement = { phase: CoinDepositPhase; proof?: LtcBurialProof | null; buried?: true; goneAt?: number | null }

  function uncheckedSince(coin: Coin, now: number): CoinDepositPhase {
    const prior = coin.phase
    const last =
      prior?.kind === 'confirming'
        ? { confirmations: prior.confirmations, needed: prior.needed, height: prior.height, checkedAt: prior.checkedAt }
        : prior?.kind === 'unchecked'
          ? prior.last
          : undefined
    return { kind: 'unchecked', since: prior?.kind === 'unchecked' ? prior.since : now, ...(last ? { last } : {}) }
  }

  /**
   * Where a received coin stands. Depth is only ever this wallet's own header
   * chain's answer; a source only says whether it waits for a block or which
   * block holds it. A kept proof the chain no longer holds is dropped and the
   * coin located again.
   */
  async function judge(coin: Coin, outpoint: { txid: string; vout: number }, script: Uint8Array, fresh = false): Promise<Judgement> {
    const now = Date.now()
    let proof = fresh ? undefined : coin.proof
    const kept = !!proof
    if (!proof) {
      let located
      try {
        located = await locateLtcDeposit(src(), outpoint.txid)
      } catch (err) {
        console.warn(`[${tag}] locate ${outpoint.txid.slice(0, 12)} failed — ${err instanceof Error ? err.message : String(err)}`)
        return { phase: uncheckedSince(coin, now) }
      }
      if (located.kind === 'gone') {
        const since = coin.goneAt ?? now
        return { phase: { kind: now - since >= VOID_AFTER_MS ? 'abandoned' : 'missing', since }, goneAt: since, proof: null }
      }
      if (located.kind === 'unconfirmed') return { phase: { kind: 'unconfirmed', checkedAt: now }, goneAt: null, proof: null }
      proof = located.proof
    }
    const check = await checkLtcBurial(proof, outpoint, script, BigInt(coin.litoshi), undefined, proofRules)
    if (check.ok) return { phase: { kind: 'movable', height: proof.height, checkedAt: now }, buried: true, proof, goneAt: null }
    if (check.reason === 'shallow') {
      return {
        phase: { kind: 'confirming', confirmations: check.confirmations ?? 0, needed: proofRules.depth, height: proof.height, checkedAt: now },
        proof,
        goneAt: null,
      }
    }
    if (check.reason === 'unanchored') return { phase: uncheckedSince(coin, now), proof }
    console.warn(`[${tag}] proof of ${outpoint.txid.slice(0, 12)} refused (${check.reason}) — ${check.detail}`)
    if (kept) return judge({ ...coin, proof: undefined }, outpoint, script, true)
    return { phase: uncheckedSince(coin, now), proof: null }
  }

  /** Received coins not yet buried: count each on this wallet's own chain, and keep its proof once buried. */
  async function provePass(active: ActiveWallet, opts: { skipAbandoned?: boolean } = {}): Promise<void> {
    for (const [key, coin] of Object.entries(readState().coins)) {
      if (coin.source !== 'received' || coin.proven) continue
      if (opts.skipAbandoned && coin.phase?.kind === 'abandoned') continue
      const [txid, vout] = key.split(':') as [string, string]
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'PROVE' })
      try {
        const judged = await judge(coin, { txid, vout: Number(vout) }, coinKeyOf(active, coin).script)
        const next = readState()
        const record = next.coins[key]
        if (!record) continue
        record.phase = judged.phase
        if (judged.proof === null) delete record.proof
        else if (judged.proof) record.proof = judged.proof
        if (judged.goneAt === null) delete record.goneAt
        else if (judged.goneAt !== undefined) record.goneAt = judged.goneAt
        if (judged.buried) record.proven = true
        writeState(next)
        chart.send({ type: judged.buried ? 'PROVEN' : judged.phase.kind === 'abandoned' ? 'VOIDED' : 'PENDING' })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        chart.send({ type: 'FAIL', error })
        console.warn(`[${tag}] proof ${key} deferred — ${error}`)
      } finally {
        chart.stop()
      }
    }
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  /** A source accepting a payment is not the network keeping it: checked until it is in a block, re-broadcast whenever no source knows it. */
  async function keepAlive(txid: string, p: Payment): Promise<void> {
    const status = await src()
      .txStatus(txid)
      .catch(() => null)
    if (status?.confirmed) {
      const next = readState()
      const current = next.payments[txid]
      if (current) {
        current.confirmed = true
        writeState(next)
        const paid = current.inputs.filter((key) => next.coins[key]?.paidBy)
        const active = getWalletRuntime()?.instance
        if (active && paid.length) appendCustody(ownerOf(active), paid.map((key) => ({ k: 'spent', op: custodyOp(key) })))
      }
      return
    }
    if (status) return
    try {
      await src().broadcast(p.hex)
      console.info(`[${tag}] payment ${txid} was not on the network — re-broadcast`)
    } catch (err) {
      console.warn(`[${tag}] payment ${txid} re-broadcast failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function broadcast(txid: string, p: Payment): Promise<boolean> {
    try {
      const known = await src()
        .txStatus(txid)
        .catch(() => null)
      if (!known) await src().broadcast(p.hex)
      const next = readState()
      const current = next.payments[txid]
      if (current) {
        current.status = 'sent'
        delete current.lastError
        writeState(next)
      }
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const next = readState()
      const current = next.payments[txid]
      if (current) {
        current.attempts += 1
        current.lastError = message
        writeState(next)
      }
      console.warn(`[${tag}] payment ${txid} broadcast queued — ${message}`)
      return false
    }
  }

  /** Signed payments land: one never broadcast is broadcast, one sent is kept alive until it confirms. */
  async function settlePayments(): Promise<void> {
    for (const [txid, p] of Object.entries(readState().payments)) {
      if (p.confirmed) continue
      if (p.status === 'sent') {
        await keepAlive(txid, p)
        continue
      }
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'RESUME_BROADCAST', txid })
      chart.send((await broadcast(txid, p)) ? { type: 'BROADCASTED' } : { type: 'BROADCAST_QUEUED', error: readState().payments[txid]?.lastError ?? 'broadcast failed' })
      chart.stop()
    }
  }

  function unitsOf(raw: unknown): bigint {
    const text = String(raw ?? '').trim()
    if (!/^\d+$/.test(text) || BigInt(text) < binding.dust) refuse('bad-args', `amount is a whole number of the smallest unit, at least ${binding.dust}.`)
    return BigInt(text)
  }

  function addressDestination(active: ActiveWallet, raw: unknown): Destination {
    const address = typeof raw === 'string' ? raw.trim() : ''
    let script: Uint8Array
    try {
      script = binding.outputScript(address)
    } catch (err) {
      return refuse('bad-args', `address is not a ${label} mainnet address (${err instanceof Error ? err.message : String(err)}).`)
    }
    if (sameBytes(script, keyOf(active).script)) refuse('own-address', `That is this wallet's own ${label} address; sending to it only spends the network fee.`)
    return { address, script }
  }

  /** The recipient a payment names: an address on this chain, or an identity (BRC-213 §7). Never both. */
  function recipientOf(active: ActiveWallet, args: SendCoinArgs): { kind: 'address'; address: unknown } | { kind: 'identity'; identityKey: string } {
    if (args.identityKey === undefined) return { kind: 'address', address: args.address }
    if (args.address !== undefined) refuse('bad-args', 'name an address or an identityKey, not both.')
    const identityKey = typeof args.identityKey === 'string' ? args.identityKey.trim().toLowerCase() : ''
    if (!IDENTITY_KEY.test(identityKey)) refuse('bad-args', 'identityKey is a compressed public key in hex.')
    if (identityKey === active.identityKey.trim().toLowerCase()) refuse('own-address', `That is this wallet's own identity; sending to it only spends the network fee.`)
    return { kind: 'identity', identityKey }
  }

  /**
   * A payment to an identity is locked to a key only the recipient's wallet
   * derives, from a notice only its wallet reads. Sent to a wallet that does
   * neither, the coins are lost; so it is refused unless the recipient's
   * signed record says its wallet receives them.
   */
  async function requireRecipientSupport(identityKey: string): Promise<void> {
    const { coinRecipientSupport } = await import('../walletProtocols')
    const support = await coinRecipientSupport(identityKey, chain)
    if (support.kind === 'supported') return
    if (support.kind === 'unreachable') {
      refuse('recipient-unchecked', `Could not check whether the recipient's wallet receives ${label} (${support.reason}).`)
    }
    refuse(
      'unsupported-recipient',
      support.kind === 'unsupported'
        ? `The recipient's wallet does not receive ${label} sent to its identity.`
        : `The recipient's wallet has not said it receives ${label} sent to its identity.`,
    )
  }

  /** A fresh BRC-42 child of the recipient's identity for this payment alone, so no two payments share an address. */
  function identityDestination(active: ActiveWallet, identityKey: string): Destination {
    const keyId = toHex(crypto.getRandomValues(new Uint8Array(16)))
    const pub = new KeyDeriver(PrivateKey.fromHex(active.rootKeyHex)).derivePublicKey(binding.paymentProtocol, keyId, identityKey, false)
    const bytes = Uint8Array.from(pub.encode(true) as number[])
    return { address: binding.address(bytes), script: binding.script(bytes), to: { identityKey, keyId } }
  }

  /** One install per account, as for BSV: an account another device holds never signs here. */
  function refuseHeldElsewhere(active: ActiveWallet): void {
    const heldElsewhere = activeAccountSpendRefusal(active)
    if (heldElsewhere) refuse('held-elsewhere', heldElsewhere)
  }

  /** Refuse a payment the wallet would refuse anyway, before anyone is asked to approve it. Local state only. */
  function preflightSend(args: SendCoinArgs): void {
    const active = requireActive()
    refuseHeldElsewhere(active)
    migrate()
    const units = unitsOf(args.litoshi)
    const recipient = recipientOf(active, args)
    if (recipient.kind === 'address') addressDestination(active, recipient.address)
    const { spendable: ready } = balanceOf(readState())
    if (ready < units) refuse('insufficient', `This wallet can spend ${fmt(ready)}, less than ${fmt(units)}.`)
  }

  /** {@link preflightSend}, and for an identity its wallet's signed record: everything refused before an approval is asked for. */
  async function preflightRecipient(args: SendCoinArgs): Promise<void> {
    preflightSend(args)
    const recipient = recipientOf(requireActive(), args)
    if (recipient.kind === 'identity') await requireRecipientSupport(recipient.identityKey)
  }

  /** Choose this wallet's spendable coins (each re-read as unspent) for `outputs` plus the fee, and sign. */
  async function signOutputs(active: ActiveWallet, outputs: ReadonlyArray<{ script: Uint8Array; value: bigint }>): Promise<{ plan: CoinPaymentPlan; signed: LtcTx; txid: string }> {
    const own = keyOf(active)
    const state = readState()
    const spent = spentKeys(state)
    const keys = new Map<string, CoinKey>()
    for (const [key, coin] of Object.entries(state.coins)) {
      if (!spent.has(key) && spendable(state, key, coin)) keys.set(key, coinKeyOf(active, coin))
    }
    const unspent = new Set<string>()
    for (const address of new Set([...keys.values()].map((k) => k.address))) {
      for (const u of await src().addressUtxos(address)) unspent.add(outpointKey(u.txid, u.vout))
    }
    const coins = [...keys.keys()]
      .filter((key) => unspent.has(key))
      .map((key) => {
        const [txid, vout] = key.split(':') as [string, string]
        return { txid, vout: Number(vout), litoshi: BigInt(state.coins[key]!.litoshi) }
      })
      .sort((a, b) => (b.litoshi > a.litoshi ? 1 : b.litoshi < a.litoshi ? -1 : 0))
    const total = outputs.reduce((sum, o) => sum + o.value, 0n)
    const plan = planCoinOutputs(binding, coins, outputs, own.script, await src().feeRate())
    if (!plan) refuse('insufficient', `This wallet cannot pay ${fmt(total)} plus its fee from its spendable coins.`)
    const signed = binding.sign(
      plan.tx,
      plan.inputs.map((key) => keys.get(key)!.key),
      plan.amounts,
    )
    return { plan, signed, txid: binding.txid(signed) }
  }

  /**
   * Pay `litoshi` (the smallest unit) to `address`, or to `identityKey`
   * (BRC-213 §7), from this wallet's spendable coins, the fee on top. Guarded
   * as a BSV spend is: online, and only on the install holding the account
   * (re-checked after a gap). The payment is signed and recorded before it is
   * broadcast; a failed broadcast is retried until it confirms. A payment to
   * an identity then owes its recipient a notice, retried until delivered,
   * which never gates the payment. `origin` is the app that asked, for its
   * Activity row; `toLabel` names the recipient there.
   */
  function send(args: SendCoinArgs, opts: { origin?: string; toLabel?: string } = {}): Promise<SendCoinResult> {
    return serial(async () => {
      const active = requireActive()
      assertOnlineForPayment()
      refuseHeldElsewhere(active)
      const { ensureHoldingFresh } = await import('../accountMove')
      await ensureHoldingFresh(active)
      refuseHeldElsewhere(active)
      migrate()
      const startedAt = Date.now()
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'SEND' })
      try {
        const units = unitsOf(args.litoshi)
        const recipient = recipientOf(active, args)
        if (recipient.kind === 'identity') await requireRecipientSupport(recipient.identityKey)
        const destination = recipient.kind === 'identity' ? identityDestination(active, recipient.identityKey) : addressDestination(active, recipient.address)
        await settlePayments()
        const { plan, signed, txid } = await signOutputs(active, [{ script: destination.script, value: units }])
        const payment: Payment = {
          address: destination.address,
          litoshi: units.toString(),
          fee: plan.fee.toString(),
          hex: toHex(binding.serialize(signed)),
          inputs: plan.inputs,
          ...(plan.change ? { change: { vout: plan.change.vout, litoshi: plan.change.litoshi.toString() } } : {}),
          ...(destination.to ? { to: { ...destination.to, vout: 0, notice: { attempts: 0 } } } : {}),
          status: 'signed',
          at: Date.now(),
          attempts: 0,
        }
        const next = readState()
        next.payments[txid] = payment
        if (plan.change) next.coins[outpointKey(txid, plan.change.vout)] = { litoshi: plan.change.litoshi.toString(), at: payment.at, source: 'change' }
        writeState(next)
        chart.send({ type: 'SIGNED', txid })
        const shown = destination.to ? (opts.toLabel ?? `${destination.to.identityKey.slice(0, 10)}…`) : destination.address
        recordAppActivity({
          origin: opts.origin ?? WALLET_ACTIVITY_ORIGIN,
          kind: 'spent',
          sats: 0,
          method: binding.activity.send,
          note: `To ${shown} · ${fmt(plan.fee)} network fee`,
          txid,
          item: activityItem(units),
        })
        const sent = await broadcast(txid, payment)
        chart.send(sent ? { type: 'BROADCASTED' } : { type: 'BROADCAST_QUEUED', error: readState().payments[txid]?.lastError ?? 'broadcast failed' })
        if (sent && destination.to) void serial(() => deliverNotices(active))
        const ms = Date.now() - startedAt
        if (ms > 250) console.info(`[${tag}] send done ${ms}ms`)
        return { ltcTxid: txid, litoshi: units.toString(), fee: plan.fee.toString(), status: sent ? 'sent' : 'queued' }
      } catch (err) {
        chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        chart.stop()
      }
    })
  }

  // ── Hash-locked outputs (swaps) ──────────────────────────────────────────

  /**
   * Lock `outputs` (a swap's hash-locked outputs) from this wallet's spendable
   * coins, the fee on top. Guarded and recorded exactly as {@link send}: the
   * payment is signed and recorded before it is broadcast, and kept alive
   * until it confirms. Output `i` of the transaction is `outputs[i]`.
   */
  function fundLocks(
    outputs: ReadonlyArray<{ script: Uint8Array; litoshi: bigint; address: string }>,
    opts: { swapId: string; origin?: string; note: string },
  ): Promise<SendCoinResult> {
    return serial(async () => {
      const active = requireActive()
      assertOnlineForPayment()
      refuseHeldElsewhere(active)
      const { ensureHoldingFresh } = await import('../accountMove')
      await ensureHoldingFresh(active)
      refuseHeldElsewhere(active)
      migrate()
      if (outputs.length === 0 || outputs.some((o) => o.litoshi < binding.dust)) refuse('bad-args', `each lock holds at least ${binding.dust}.`)
      const startedAt = Date.now()
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'SEND' })
      try {
        await settlePayments()
        const total = outputs.reduce((sum, o) => sum + o.litoshi, 0n)
        const { plan, signed, txid } = await signOutputs(
          active,
          outputs.map((o) => ({ script: o.script, value: o.litoshi })),
        )
        const payment: Payment = {
          address: outputs[0]!.address,
          litoshi: total.toString(),
          fee: plan.fee.toString(),
          hex: toHex(binding.serialize(signed)),
          inputs: plan.inputs,
          ...(plan.change ? { change: { vout: plan.change.vout, litoshi: plan.change.litoshi.toString() } } : {}),
          lock: { swapId: opts.swapId },
          status: 'signed',
          at: Date.now(),
          attempts: 0,
        }
        const next = readState()
        next.payments[txid] = payment
        if (plan.change) next.coins[outpointKey(txid, plan.change.vout)] = { litoshi: plan.change.litoshi.toString(), at: payment.at, source: 'change' }
        writeState(next)
        chart.send({ type: 'SIGNED', txid })
        recordAppActivity({
          origin: opts.origin ?? WALLET_ACTIVITY_ORIGIN,
          kind: 'spent',
          sats: 0,
          method: binding.activity.send,
          note: `${opts.note} · ${fmt(plan.fee)} network fee`,
          txid,
          item: activityItem(total),
        })
        const sent = await broadcast(txid, payment)
        chart.send(sent ? { type: 'BROADCASTED' } : { type: 'BROADCAST_QUEUED', error: readState().payments[txid]?.lastError ?? 'broadcast failed' })
        const ms = Date.now() - startedAt
        if (ms > 250) console.info(`[${tag}] lock done ${ms}ms`)
        return { ltcTxid: txid, litoshi: total.toString(), fee: plan.fee.toString(), status: sent ? 'sent' : 'queued' }
      } catch (err) {
        chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        chart.stop()
      }
    })
  }

  /**
   * Where a lock stands: its output checked against the raw transaction, its
   * depth only from this wallet's own header chain, as a received coin's is.
   */
  async function proveLock(outpoint: { txid: string; vout: number }, scriptPubKey: Uint8Array, litoshi: bigint): Promise<LockSighting> {
    let located
    try {
      located = await locateLtcDeposit(src(), outpoint.txid)
    } catch (err) {
      return { kind: 'unchecked', detail: err instanceof Error ? err.message : String(err) }
    }
    if (located.kind === 'gone') return { kind: 'gone' }
    if (located.kind === 'unconfirmed') {
      const seen = await readLtcDeposit(src(), outpoint, scriptPubKey, proofRules).catch((err: unknown) => ({ kind: 'error' as const, detail: String(err) }))
      if (seen.kind === 'refuse') return { kind: 'refused', reason: seen.reason, detail: seen.detail }
      if (seen.kind === 'seen' && seen.litoshi !== litoshi) return { kind: 'refused', reason: 'under-backed', detail: `the lock holds ${seen.litoshi}, not ${litoshi}` }
      return { kind: 'unconfirmed' }
    }
    const check = await checkLtcBurial(located.proof, outpoint, scriptPubKey, litoshi, undefined, proofRules)
    if (check.ok) {
      if (check.litoshi !== litoshi) return { kind: 'refused', reason: 'under-backed', detail: `the lock holds ${check.litoshi}, not ${litoshi}` }
      return { kind: 'buried' }
    }
    if (check.reason === 'shallow') return { kind: 'confirming', confirmations: check.confirmations ?? 0, needed: proofRules.depth }
    if (check.missing) return { kind: 'unchecked', detail: check.detail }
    return { kind: 'refused', reason: check.reason, detail: check.detail }
  }

  /** The transaction spending `outpoint`, found in the history of `address` and checked by its hash; null while unspent. */
  async function spenderOf(outpoint: { txid: string; vout: number }, address: string): Promise<LtcTx | null> {
    const history = src().scriptHistory
    if (!history) throw new Error(`The ${label} source cannot list an address's transactions`)
    for (const txid of await history(address)) {
      if (txid === outpoint.txid) continue
      const tx = proofRules.parseTx(fromHex(await src().txHex(txid)))
      if (ltcTxid(tx) !== txid) continue
      if (tx.inputs.some((i) => i.txid === outpoint.txid && i.vout === outpoint.vout)) return tx
    }
    return null
  }

  /** Broadcast a transaction this wallet built outside its payment record (a swap claim or refund). Safe to repeat. */
  async function broadcastRaw(hex: string, txid: string): Promise<'sent' | 'known'> {
    const known = await src()
      .txStatus(txid)
      .catch(() => null)
    if (known) return 'known'
    await src().broadcast(hex)
    return 'sent'
  }

  /** The script a claim or refund pays back into this wallet; the watcher reads the address for it a while. */
  function receiveScript(): { script: Uint8Array; address: string } {
    const active = requireActive()
    const own = keyOf(active)
    writeState({ ...readState(), expectUntil: Date.now() + EXPECT_COINS_MS })
    return { script: own.script, address: own.address }
  }

  // ── Payments to an identity (BRC-213 §7) ─────────────────────────────────

  const owesNotice = (p: Payment) => !!p.to && !p.to.notice.delivered && p.status === 'sent'
  const hasOwedNotices = (state: CoinState) => Object.values(state.payments).some(owesNotice)

  /** Tell each recipient paid at its identity which key its coins are locked to. Failure reschedules, never touches the payment. */
  async function deliverNotices(active: ActiveWallet): Promise<void> {
    const now = Date.now()
    for (const [txid, p] of Object.entries(readState().payments)) {
      if (!p.to || !owesNotice(p) || (p.to.notice.nextAt ?? 0) > now) continue
      const notice: CoinPaymentNotice = { v: 1, t: 'coin-payment', chain, txid, vout: p.to.vout, keyId: p.to.keyId }
      let error: string | null = null
      try {
        const { sendSealedToPeerBox } = await import('../messageTransport')
        await sendSealedToPeerBox(active.rootKeyHex, p.to.identityKey, COIN_PAYMENT_BOX, JSON.stringify(notice))
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      const next = readState()
      const to = next.payments[txid]?.to
      if (!to) continue
      const attempts = to.notice.attempts + 1
      if (error === null) {
        to.notice = { delivered: true, attempts }
      } else {
        to.notice = { attempts, nextAt: Date.now() + NOTICE_RETRY_MS[Math.min(attempts - 1, NOTICE_RETRY_MS.length - 1)]!, lastError: error.slice(0, 200) }
        console.warn(`[${tag}] notice of ${txid.slice(0, 12)} to ${to.identityKey.slice(0, 12)}… queued — ${error}`)
      }
      writeState(next)
    }
  }

  /**
   * A notice from `sender` that it paid this wallet's identity. The output is
   * read from its raw transaction and must pay the key derived for `sender`
   * under the notice's key id; the amount is the output's, never the notice's.
   * `recorded`: the coin is held (or already was). `refused`: the notice can
   * never be good. A throw: the transaction could not be read yet.
   */
  function ingestPaymentNotice(sender: string, notice: CoinPaymentNotice): Promise<'recorded' | 'refused'> {
    return serial(async () => {
      const active = requireActive()
      const from = sender.trim().toLowerCase()
      if (
        !IDENTITY_KEY.test(from) ||
        notice.chain !== chain ||
        !KEY_ID.test(notice.keyId) ||
        !/^[0-9a-f]{64}$/.test(notice.txid) ||
        !Number.isSafeInteger(notice.vout) ||
        notice.vout < 0
      ) {
        return 'refused'
      }
      migrate()
      const key = outpointKey(notice.txid, notice.vout)
      if (readState().coins[key]) return 'recorded'
      const paidBy: CoinSender = { sender: from, keyId: notice.keyId }
      const chart = createActor(coinMachine).start()
      chart.send({ type: 'RECEIVE' })
      try {
        const sighting = await readLtcDeposit(src(), { txid: notice.txid, vout: notice.vout }, paidKeyOf(active, paidBy).script, proofRules)
        if (sighting.kind === 'refuse') {
          chart.send({ type: 'REFUSED', error: sighting.reason })
          console.warn(`[${tag}] notice ${key} from ${from.slice(0, 12)}… refused (${sighting.reason}) — ${sighting.detail}`)
          return 'refused'
        }
        journalPaidCoin(active, key, sighting.litoshi, paidBy)
        const next = readState()
        if (!next.coins[key]) {
          next.coins[key] = { litoshi: sighting.litoshi.toString(), at: Date.now(), source: 'received', paidBy }
          writeState(next)
          recordAppActivity({
            origin: WALLET_ACTIVITY_ORIGIN,
            kind: 'earned',
            sats: 0,
            method: binding.activity.receive,
            note: `${label} ${key}`,
            txid: notice.txid,
            item: activityItem(sighting.litoshi),
            from,
          })
        }
        chart.send({ type: 'SEEN' })
        return 'recorded'
      } catch (err) {
        chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        chart.stop()
      }
    })
  }

  /**
   * Coins paid to this identity that the custody journal holds and this
   * record lost (a restore, a wiped install): read again from the chain, as a
   * notice would be. One the chain shows spent (its transaction in a block, its
   * output no longer unspent) is journaled spent and never read again.
   */
  async function replayPaidCoins(active: ActiveWallet): Promise<void> {
    const owner = ownerOf(active)
    for (const { op, r } of unspentCoinCustody(owner, chain)) {
      const key = op.replace('.', ':')
      if (readState().coins[key]) continue
      const [txid, vout] = key.split(':') as [string, string]
      const paidBy: CoinSender = { sender: r.sender, keyId: r.keyId }
      const paid = paidKeyOf(active, paidBy)
      try {
        const unspent = (await src().addressUtxos(paid.address)).some((u) => u.txid === txid && u.vout === Number(vout))
        if (!unspent) {
          const status = await src()
            .txStatus(txid)
            .catch(() => null)
          if (status?.confirmed) appendCustody(owner, [{ k: 'spent', op }])
          continue
        }
        const sighting = await readLtcDeposit(src(), { txid, vout: Number(vout) }, paid.script, proofRules)
        if (sighting.kind === 'refuse') continue
        const next = readState()
        if (next.coins[key]) continue
        next.coins[key] = { litoshi: sighting.litoshi.toString(), at: Date.now(), source: 'received', paidBy }
        writeState(next)
        console.info(`[${tag}] restored ${key} paid by ${r.sender.slice(0, 12)}… from the custody journal`)
      } catch (err) {
        console.warn(`[${tag}] restore ${key} deferred — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  function phaseOf(coin: Coin): CoinDepositPhase {
    if (coin.source === 'received' && !coin.proven) return coin.phase ?? { kind: 'unchecked', since: coin.at }
    if (coin.phase?.kind === 'movable') return coin.phase
    return coin.proof ? { kind: 'movable', height: coin.proof.height } : { kind: 'movable' }
  }

  function report(active: ActiveWallet): CoinWalletReport {
    const state = readState()
    const spent = spentKeys(state)
    const b = balanceOf(state)
    return {
      address: keyOf(active).address,
      balance: { spendable: b.spendable.toString(), confirming: b.confirming.toString() },
      coins: Object.entries(state.coins)
        .sort(([, a], [, z]) => z.at - a.at)
        .map(([key, coin]) => {
          const [txid, vout] = key.split(':') as [string, string]
          return { txid, vout: Number(vout), litoshi: coin.litoshi, source: coin.source, phase: phaseOf(coin), spent: spent.has(key) }
        }),
      payments: Object.entries(state.payments)
        .sort(([, a], [, z]) => z.at - a.at)
        .map(([txid, p]) => ({
          ltcTxid: txid,
          address: p.address,
          litoshi: p.litoshi,
          fee: p.fee,
          status: p.status,
          confirmed: p.confirmed === true,
          ...(p.lastError ? { lastError: p.lastError } : {}),
          ...(p.to ? { to: { identityKey: p.to.identityKey, notified: p.to.notice.delivered === true } } : {}),
        })),
    }
  }

  /** Read the address for new coins, count waiting ones, settle payments, and report. */
  function refresh(): Promise<CoinWalletReport> {
    return serial(async () => {
      const active = requireActive()
      migrate()
      await settlePayments()
      await deliverNotices(active)
      await receivePass(active)
      await replayPaidCoins(active)
      await provePass(active)
      return report(active)
    })
  }

  /** Received coins of the open account, newest first, as deposit views. No network. */
  function readCoinViews(): CoinDepositView[] {
    if (!getWalletRuntime()?.instance) return []
    return Object.entries(readState().coins)
      .filter(([, coin]) => coin.source === 'received')
      .sort(([, a], [, z]) => z.at - a.at)
      .map(([key, coin]) => {
        const [txid, vout] = key.split(':') as [string, string]
        return { txid, vout: Number(vout), litoshi: coin.litoshi, at: coin.at, phase: phaseOf(coin) }
      })
  }

  // ── Watcher ──────────────────────────────────────────────────────────────

  let watchTimer: ReturnType<typeof setInterval> | null = null
  let lastScanAt = 0

  const hasWaiting = (state: CoinState) =>
    Object.values(state.coins).some((c) => c.source === 'received' && !c.proven && c.phase?.kind !== 'abandoned')
  const hasUnconfirmed = (state: CoinState) => Object.values(state.payments).some((p) => !p.confirmed)

  /**
   * One pass. `scanned`: the address was read for new coins (once per install,
   * every pass while one is expected, otherwise every {@link IDLE_SCAN_MS} once
   * the account has shown its address or held a coin on this chain) and
   * waiting ones counted. `counted`: only waiting coins and unconfirmed payments were
   * checked. `idle`: nothing was due, nothing touched the network.
   */
  async function watch(): Promise<'idle' | 'counted' | 'scanned'> {
    const active = getWalletRuntime()?.instance
    if (!active) return 'idle'
    migrate()
    const state = readState()
    const now = Date.now()
    // An account that never showed its address on this chain cannot have been paid on it.
    const used = state.expectUntil !== undefined || Object.keys(state.coins).length > 0
    const discover = state.discoveredAt === undefined
    const scan = discover || (state.expectUntil ?? 0) > now || (used && now - lastScanAt >= IDLE_SCAN_MS)
    const payments = hasUnconfirmed(state)
    const owed = hasOwedNotices(state)
    if (!scan && !payments && !owed && !hasWaiting(state)) return 'idle'
    return serial(async () => {
      if (payments) await settlePayments()
      if (payments || owed) await deliverNotices(active)
      if (scan) {
        lastScanAt = now
        await receivePass(active)
        await replayPaidCoins(active)
        if (discover) writeState({ ...readState(), discoveredAt: now })
      }
      await provePass(active, { skipAbandoned: true })
      return scan ? 'scanned' : 'counted'
    })
  }

  /** Once a minute while the wallet is visible. */
  function startWatcher(): void {
    if (watchTimer) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      void watch().catch((err: unknown) => {
        console.warn(`[${tag}] watch pass failed — ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    watchTimer = setInterval(tick, WATCH_MS)
    setTimeout(tick, 5_000)
  }

  // ── App methods ──────────────────────────────────────────────────────────

  async function listForApp(): Promise<CoinAppReport> {
    const r = await refresh()
    return {
      address: r.address,
      balance: (BigInt(r.balance.spendable) + BigInt(r.balance.confirming)).toString(),
      locked: r.balance.confirming,
      deposits: r.coins
        .filter((c) => c.source === 'received')
        .map((c) => {
          const count = depositCount(chain, c.phase)
          return {
            txid: c.txid,
            vout: c.vout,
            litoshi: c.litoshi,
            status: c.phase.kind === 'abandoned' ? ('void' as const) : ('credited' as const),
            proven: c.phase.kind === 'movable',
            ...(c.phase.kind === 'movable' ? {} : { confirmations: count.counted }),
            needed: count.needed,
          }
        }),
      withdrawals: r.payments,
    }
  }

  return {
    binding,
    coinKey,
    activityItem,
    store,
    ensureMigrated: migrate,
    readBalance,
    getAddress,
    addressForApp: () => ({ address: getAddress(), minConfirmations: proofRules.depth, decimals: binding.decimals }),
    preflightSend,
    preflightRecipient,
    send,
    fundLocks,
    proveLock,
    spenderOf,
    broadcastRaw,
    receiveScript,
    feeRate: () => src().feeRate(),
    ingestPaymentNotice,
    refresh,
    readCoinViews,
    watch,
    startWatcher,
    listForApp,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Tests swap the source; null restores the default. */
    setSourceForTest(next: LtcChain | null): void {
      source = next
    },
    /** Tests start each case with no scan behind it. */
    resetWatchForTest(): void {
      lastScanAt = 0
    },
  }
}

export type CoinWallet = ReturnType<typeof createCoinWallet>
