/**
 * Server wallet — a key this wallet derives, a developer's server spends, and
 * this wallet only tracks.
 *
 * Custody: the key is a BRC-42 self child of the account root under
 * `[2, 'handcash server wallet']`, keyID = generation. It is never the BAP
 * signing key (published, rotated for identity reasons) and never a Toolbox
 * key, so its outputs are outside `localState`: not in the balance, not
 * selectable by a send, not swept by Refresh. The only spend this wallet makes
 * is the explicit Recover chart.
 *
 * Tracking: the server reports every transaction that spends from or pays the
 * key to this identity's `server_wallet` BRC-33 box (or a live BRC-246 direct
 * session), sealed with the server key. A report is accepted only from a
 * derived server key, only after the Atomic BEEF SPV-verifies, and each
 * reported output only if its lock is P2PKH of the child key named by the
 * report's derivation. Reports are acknowledged after ingest; an incomplete
 * package stays in the box for the next poll.
 */
import {
  Beef,
  createNonce,
  KeyDeriver,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  SatoshisPerKilobyte,
  Transaction,
  Utils,
  type WalletProtocol,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { storageRegistry } from '../storage/registry'
import {
  accountKeyScopeFor,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { BRC29_PROTOCOL_ID } from './sendBrc29Payment'
import type { ActiveWallet } from './session'
import { serverWalletRecoverMachine } from './serverWalletRecoverMachine'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  requireWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

export const SERVER_WALLET_PROTOCOL: WalletProtocol = [2, 'handcash server wallet']
/** BRC-33 box the server posts reports to. */
export const SERVER_WALLET_BOX = 'server_wallet'
export const SERVER_WALLET_REPORT_TYPE = 'server-wallet.report'
/** Toolbox `defaultOptions().feeModel`. */
const FEE_SAT_PER_KB = 100
/** Later generations a report may adopt (restore from seed loses the counter). */
const GENERATION_LOOKAHEAD = 8
const POLL_INTERVAL_MS = 30_000

const KEY = storageRegistry.serverWallet.key

/** Lock of a server-wallet output, named by the derivation that unlocks it. */
export type ServerWalletLock =
  | { kind: 'root' }
  | {
      kind: 'brc29'
      derivationPrefix: string
      derivationSuffix: string
      /** BRC-29 sender identity key, or `self` for the server's own change. */
      sender: string
    }

export type TrackedServerOutput = {
  outpoint: string
  satoshis: number
  generation: number
  lock: ServerWalletLock
  seenAt: number
}

/** A registered recovery whose self payment is not yet internalized. */
export type PendingServerRecover = {
  txid: string
  atomicBeefB64: string
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}

export type ServerWalletLedger = {
  v: 1
  generation: number
  outputs: TrackedServerOutput[]
  lastReportAt: number | null
  pendingRecover: PendingServerRecover | null
}

export type ServerWalletReport = {
  txid: string
  beef: number[]
  outputs: Array<{ vout: number; lock: ServerWalletLock }>
}

export type ServerWalletReportRefusal =
  | 'malformed'
  | 'not-set-up'
  | 'unknown-sender'
  | 'retired-key'
  | 'invalid-package'

export type ServerWalletReportVerdict =
  | { kind: 'ingested'; added: number; spent: number; generation: number }
  /** Never ingestible; acknowledge so it leaves the box. */
  | { kind: 'refused'; reason: ServerWalletReportRefusal }
  /** Retry on the next poll; do not acknowledge. */
  | { kind: 'deferred'; reason: string }

export type ServerWalletRecoverRefusal = 'nothing-tracked' | 'uneconomical'

export type ServerWalletRecoverPlan =
  | { path: 'recover'; outputs: TrackedServerOutput[]; totalSats: number }
  | { path: 'finish'; pending: PendingServerRecover }
  | { path: 'refuse'; reason: ServerWalletRecoverRefusal }

export type ServerWalletStatus =
  | { kind: 'off' }
  | {
      kind: 'ready'
      generation: number
      identityKey: string
      address: string
      trackedSats: number
      outputs: number
      lastReportAt: number | null
      pendingRecover: boolean
    }

// ── key ────────────────────────────────────────────────────────────────────

export function serverWalletKey(rootKeyHex: string, generation: number): PrivateKey {
  return new KeyDeriver(PrivateKey.fromHex(rootKeyHex.trim())).derivePrivateKey(
    SERVER_WALLET_PROTOCOL,
    String(generation),
    'self',
  )
}

/** Child key that unlocks an output with this lock. */
export function serverWalletSpendKey(server: PrivateKey, lock: ServerWalletLock): PrivateKey {
  if (lock.kind === 'root') return server
  return new KeyDeriver(server).derivePrivateKey(
    BRC29_PROTOCOL_ID,
    `${lock.derivationPrefix} ${lock.derivationSuffix}`,
    lock.sender === 'self' ? 'self' : PublicKey.fromString(lock.sender),
  )
}

function lockingScriptHex(key: PrivateKey): string {
  return new P2PKH().lock(key.toPublicKey().toHash()).toHex()
}

/**
 * Which generation signed this sender key. A later one is adopted (restore
 * from seed resets the counter); an earlier one was retired by Rotate.
 */
export function matchServerWalletGeneration(
  rootKeyHex: string,
  current: number,
  sender: string,
):
  | { kind: 'current'; generation: number }
  | { kind: 'later'; generation: number }
  | { kind: 'retired' }
  | { kind: 'unknown' } {
  const want = sender.trim().toLowerCase()
  for (let g = current; g <= current + GENERATION_LOOKAHEAD; g += 1) {
    if (serverWalletKey(rootKeyHex, g).toPublicKey().toString() === want) {
      return g === current ? { kind: 'current', generation: g } : { kind: 'later', generation: g }
    }
  }
  for (let g = 1; g < current; g += 1) {
    if (serverWalletKey(rootKeyHex, g).toPublicKey().toString() === want) {
      return { kind: 'retired' }
    }
  }
  return { kind: 'unknown' }
}

// ── ledger ─────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let revision = 0

export function subscribeServerWallet(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function serverWalletRevision(): number {
  return revision
}

export function readServerWalletLedger(owner: BoundAccountKeyScope): ServerWalletLedger | null {
  const raw = durableGetItem(accountLocalKeyFor(KEY, owner))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ServerWalletLedger>
    if (parsed.v !== 1 || !Number.isInteger(parsed.generation) || !Array.isArray(parsed.outputs)) {
      return null
    }
    return {
      v: 1,
      generation: parsed.generation!,
      outputs: parsed.outputs,
      lastReportAt: parsed.lastReportAt ?? null,
      pendingRecover: parsed.pendingRecover ?? null,
    }
  } catch {
    return null
  }
}

function writeLedger(owner: BoundAccountKeyScope, ledger: ServerWalletLedger): void {
  if (!durableSetItem(accountLocalKeyFor(KEY, owner), JSON.stringify(ledger))) {
    throw new Error('Could not save the server wallet ledger')
  }
  revision += 1
  for (const listener of listeners) listener()
}

function requireLedger(owner: BoundAccountKeyScope): ServerWalletLedger {
  const ledger = readServerWalletLedger(owner)
  if (!ledger) throw new Error('Set up the server wallet first')
  return ledger
}

export function describeServerWallet(runtime: WalletRuntime): ServerWalletStatus {
  const active = runtime.instance
  const ledger = readServerWalletLedger(accountKeyScopeFor(active))
  if (!ledger) return { kind: 'off' }
  const pub = serverWalletKey(active.rootKeyHex, ledger.generation).toPublicKey()
  return {
    kind: 'ready',
    generation: ledger.generation,
    identityKey: pub.toString(),
    address: pub.toAddress(active.chain === 'main' ? 'mainnet' : 'testnet'),
    trackedSats: ledger.outputs.reduce((sum, out) => sum + out.satoshis, 0),
    outputs: ledger.outputs.length,
    lastReportAt: ledger.lastReportAt,
    pendingRecover: ledger.pendingRecover != null,
  }
}

export function setUpServerWallet(runtime: WalletRuntime): void {
  const owner = accountKeyScopeFor(runtime.instance)
  if (readServerWalletLedger(owner)) return
  writeLedger(owner, {
    v: 1,
    generation: 1,
    outputs: [],
    lastReportAt: null,
    pendingRecover: null,
  })
  console.info('[server-wallet] set up generation 1')
}

/** Everything the server needs, as one line: its key and where to report. */
export async function exportServerWalletConfig(runtime: WalletRuntime): Promise<string> {
  const active = runtime.instance
  const ledger = requireLedger(accountKeyScopeFor(active))
  const { normalizeMessageboxBase } = await import('./messageTransport')
  const key = serverWalletKey(active.rootKeyHex, ledger.generation)
  console.info(`[server-wallet] exported generation ${ledger.generation}`)
  return JSON.stringify({
    wif: key.toWif(active.chain === 'main' ? [0x80] : [0xef]),
    reportTo: active.identityKey,
    messageBox: SERVER_WALLET_BOX,
    messagebox: normalizeMessageboxBase(),
  })
}

/** Retire the current key. Refused while any output is still tracked under it. */
export function rotateServerWallet(runtime: WalletRuntime): number {
  const owner = accountKeyScopeFor(runtime.instance)
  const ledger = requireLedger(owner)
  if (ledger.outputs.length > 0 || ledger.pendingRecover) {
    throw new Error('Recover the tracked funds before rotating the server key')
  }
  const generation = ledger.generation + 1
  writeLedger(owner, { ...ledger, generation })
  console.info(`[server-wallet] rotated to generation ${generation}`)
  return generation
}

// ── reports ────────────────────────────────────────────────────────────────

const B64_NONCE = /^[A-Za-z0-9+/=]{1,128}$/
const PUBKEY = /^0[23][0-9a-f]{64}$/

function parseLock(raw: unknown): ServerWalletLock | null {
  if (!raw || typeof raw !== 'object') return null
  const lock = raw as Record<string, unknown>
  if (lock.kind === 'root') return { kind: 'root' }
  if (lock.kind !== 'brc29') return null
  const { derivationPrefix, derivationSuffix } = lock
  const sender = typeof lock.sender === 'string' ? lock.sender.trim().toLowerCase() : ''
  if (
    typeof derivationPrefix !== 'string' ||
    typeof derivationSuffix !== 'string' ||
    !B64_NONCE.test(derivationPrefix) ||
    !B64_NONCE.test(derivationSuffix) ||
    (sender !== 'self' && !PUBKEY.test(sender))
  ) {
    return null
  }
  return { kind: 'brc29', derivationPrefix, derivationSuffix, sender }
}

export function parseServerWalletReport(plaintext: string): ServerWalletReport | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(plaintext) as Record<string, unknown>
  } catch {
    return null
  }
  if (raw?.type !== SERVER_WALLET_REPORT_TYPE || raw.v !== 1) return null
  const txid = typeof raw.txid === 'string' ? raw.txid.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(txid) || typeof raw.beef !== 'string') return null
  let beef: number[]
  try {
    beef = Utils.toArray(raw.beef, 'base64')
  } catch {
    return null
  }
  if (beef.length === 0) return null
  const outputs: ServerWalletReport['outputs'] = []
  for (const entry of Array.isArray(raw.outputs) ? raw.outputs : []) {
    const vout = (entry as { vout?: unknown })?.vout
    const lock = parseLock((entry as { lock?: unknown })?.lock)
    if (!Number.isInteger(vout) || (vout as number) < 0 || !lock) return null
    outputs.push({ vout: vout as number, lock })
  }
  return { txid, beef, outputs }
}

/**
 * Apply a verified report: inputs that spend tracked outputs retire them;
 * reported outputs whose lock matches their derivation are tracked.
 */
export function applyServerWalletReport(args: {
  ledger: ServerWalletLedger
  generation: number
  server: PrivateKey
  tx: Transaction
  report: ServerWalletReport
  now?: number
}): { ledger: ServerWalletLedger; added: number; spent: number; mismatched: number[] } {
  const spentOutpoints = new Set(
    args.tx.inputs.map(
      (input) => `${String(input.sourceTXID ?? input.sourceTransaction?.id('hex')).toLowerCase()}.${input.sourceOutputIndex}`,
    ),
  )
  const kept = args.ledger.outputs.filter((out) => !spentOutpoints.has(out.outpoint))
  const known = new Set(kept.map((out) => out.outpoint))
  const mismatched: number[] = []
  let added = 0
  for (const { vout, lock } of args.report.outputs) {
    const output = args.tx.outputs[vout]
    const outpoint = `${args.report.txid}.${vout}`
    if (
      !output ||
      output.lockingScript.toHex() !== lockingScriptHex(serverWalletSpendKey(args.server, lock))
    ) {
      mismatched.push(vout)
      continue
    }
    if (known.has(outpoint)) continue
    known.add(outpoint)
    kept.push({
      outpoint,
      satoshis: output.satoshis ?? 0,
      generation: args.generation,
      lock,
      seenAt: args.now ?? Date.now(),
    })
    added += 1
  }
  return {
    ledger: {
      ...args.ledger,
      generation: Math.max(args.ledger.generation, args.generation),
      outputs: kept,
      lastReportAt: args.now ?? Date.now(),
    },
    added,
    spent: args.ledger.outputs.length - (kept.length - added),
    mismatched,
  }
}

export async function ingestServerWalletReport(args: {
  runtime: WalletRuntime
  sender: string
  plaintext: string
}): Promise<ServerWalletReportVerdict> {
  const started = Date.now()
  const active = args.runtime.instance
  const owner = accountKeyScopeFor(active)
  const report = parseServerWalletReport(args.plaintext)
  if (!report) return refuse('malformed')
  const before = readServerWalletLedger(owner)
  if (!before) return refuse('not-set-up')
  const match = matchServerWalletGeneration(active.rootKeyHex, before.generation, args.sender)
  if (match.kind === 'retired') return refuse('retired-key')
  if (match.kind === 'unknown') return refuse('unknown-sender')

  const { verifySignedPackage } = await import('./spvPackage')
  const tracker = await Promise.resolve(active.services?.getChainTracker?.()).catch(() => null)
  const spv = await verifySignedPackage(report.beef, report.txid, tracker)
  if (spv.kind === 'incomplete') {
    console.info(`[server-wallet] report ${report.txid.slice(0, 12)} deferred — ${spv.reason}`)
    return { kind: 'deferred', reason: spv.reason }
  }
  if (spv.kind === 'invalid') {
    console.warn(`[server-wallet] report ${report.txid.slice(0, 12)} refused — ${spv.reason}`)
    return refuse('invalid-package')
  }
  const tx = Beef.fromBinary(report.beef).findAtomicTransaction(report.txid)
  if (!tx) return refuse('invalid-package')

  // Read again after the awaits: a concurrent report may have landed.
  const ledger = readServerWalletLedger(owner) ?? before
  const applied = applyServerWalletReport({
    ledger,
    generation: match.generation,
    server: serverWalletKey(active.rootKeyHex, match.generation),
    tx,
    report,
  })
  writeLedger(owner, applied.ledger)
  if (applied.mismatched.length > 0) {
    console.warn(
      `[server-wallet] report ${report.txid.slice(0, 12)} outputs ${applied.mismatched.join(',')} do not match their derivation — not tracked`,
    )
  }
  if (match.kind === 'later') {
    console.info(`[server-wallet] adopted generation ${match.generation} from a report`)
  }
  const ms = Date.now() - started
  console.info(
    `[server-wallet] report ${report.txid.slice(0, 12)} ingested +${applied.added} -${applied.spent}` +
      (ms >= 250 ? ` done ${ms}ms` : ''),
  )
  return { kind: 'ingested', added: applied.added, spent: applied.spent, generation: match.generation }

  function refuse(reason: ServerWalletReportRefusal): ServerWalletReportVerdict {
    console.warn(`[server-wallet] report refused — ${reason}`)
    return { kind: 'refused', reason }
  }
}

let lastPollAt = 0
let polling = false

/** Drain the `server_wallet` box. Cheap no-op unless this account set one up. */
export async function pollServerWalletReports(runtime: WalletRuntime): Promise<void> {
  if (polling || Date.now() - lastPollAt < POLL_INTERVAL_MS) return
  if (!readServerWalletLedger(accountKeyScopeFor(runtime.instance))) return
  polling = true
  lastPollAt = Date.now()
  try {
    const { acknowledgeBoxMessages, listOpenedBoxMessages } = await import('./messageTransport')
    const rootKeyHex = runtime.instance.rootKeyHex
    const listed = await listOpenedBoxMessages({ rootKeyHex, messageBox: SERVER_WALLET_BOX })
    const ack: string[] = []
    for (const message of listed) {
      if (message.plaintext == null) {
        console.warn('[server-wallet] report refused — unreadable')
        ack.push(message.messageId)
        continue
      }
      const verdict = await ingestServerWalletReport({
        runtime,
        sender: message.sender,
        plaintext: message.plaintext,
      })
      if (verdict.kind !== 'deferred') ack.push(message.messageId)
    }
    await acknowledgeBoxMessages({ rootKeyHex, messageBox: SERVER_WALLET_BOX, messageIds: ack })
  } catch (err) {
    console.warn('[server-wallet] poll failed', err)
  } finally {
    polling = false
  }
}

/** A report that arrived on a live BRC-246 direct session. */
export function acceptServerWalletDirectReport(sender: string, plaintext: string): void {
  const runtime = getWalletRuntime()
  if (!runtime) return
  void ingestServerWalletReport({ runtime, sender, plaintext }).catch((err) => {
    console.warn('[server-wallet] direct report failed', err)
  })
}

// ── fund ───────────────────────────────────────────────────────────────────

/** BRC-29 payment to the server key; the output is tracked from the moment it is signed. */
export async function fundServerWallet(satoshis: number): Promise<{ txid: string }> {
  const runtime = requireWalletRuntime()
  const active = runtime.instance
  const owner = accountKeyScopeFor(active)
  const { generation } = requireLedger(owner)
  const server = serverWalletKey(active.rootKeyHex, generation)
  const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
  const result = await sendBrc29ToIdentityKey({
    payeeIdentityKey: server.toPublicKey().toString(),
    satoshis,
    friendLabel: 'Server wallet',
    description: 'Fund server wallet',
  })
  const ledger = requireLedger(owner)
  const outpoint = `${result.txid.toLowerCase()}.${result.remittance.outputIndex ?? 0}`
  if (!ledger.outputs.some((out) => out.outpoint === outpoint)) {
    writeLedger(owner, {
      ...ledger,
      outputs: [
        ...ledger.outputs,
        {
          outpoint,
          satoshis,
          generation,
          lock: {
            kind: 'brc29',
            derivationPrefix: result.remittance.derivationPrefix,
            derivationSuffix: result.remittance.derivationSuffix,
            sender: active.identityKey.toLowerCase(),
          },
          seenAt: Date.now(),
        },
      ],
    })
  }
  console.info(`[server-wallet] funded ${satoshis} sats ${outpoint}`)
  return { txid: result.txid }
}

// ── recover ────────────────────────────────────────────────────────────────

export function planServerWalletRecover(ledger: ServerWalletLedger): ServerWalletRecoverPlan {
  if (ledger.pendingRecover) return { path: 'finish', pending: ledger.pendingRecover }
  if (ledger.outputs.length === 0) return { path: 'refuse', reason: 'nothing-tracked' }
  const totalSats = ledger.outputs.reduce((sum, out) => sum + out.satoshis, 0)
  const bytes = 10 + 148 * ledger.outputs.length + 34
  if (totalSats - Math.ceil((bytes * FEE_SAT_PER_KB) / 1000) < 1) {
    return { path: 'refuse', reason: 'uneconomical' }
  }
  return { path: 'recover', outputs: ledger.outputs, totalSats }
}

type SignedRecover = PendingServerRecover & { atomicBeef: number[] }

async function signRecover(
  active: ActiveWallet,
  outputs: TrackedServerOutput[],
): Promise<SignedRecover> {
  const { getBeefForTxidCached } = await import('./beefCache')
  const [derivationPrefix, derivationSuffix] = await Promise.all([
    createNonce(active.wallet, 'self'),
    createNonce(active.wallet, 'self'),
  ])
  const { publicKey } = await active.wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: active.identityKey,
  })
  const tx = new Transaction()
  for (const out of outputs) {
    const [txid = '', voutRaw] = out.outpoint.split('.')
    const vout = Number(voutRaw)
    const beef = await getBeefForTxidCached(active, txid)
    const source = beef.findAtomicTransaction(txid) ?? beef.findTxid(txid)?.tx
    const key = serverWalletSpendKey(serverWalletKey(active.rootKeyHex, out.generation), out.lock)
    const sourceOutput = source?.outputs[vout]
    if (!source || !sourceOutput) throw new Error(`Could not load tracked output ${out.outpoint}`)
    if (sourceOutput.lockingScript.toHex() !== lockingScriptHex(key)) {
      throw new Error(`Tracked output ${out.outpoint} is not locked to the server key`)
    }
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: vout,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })
  }
  tx.addOutput({
    lockingScript: LockingScript.fromHex(
      new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex(),
    ),
    change: true,
  })
  await tx.fee(new SatoshisPerKilobyte(FEE_SAT_PER_KB))
  const satoshis = tx.outputs[0]?.satoshis ?? 0
  if (satoshis < 1) throw new Error('Tracked funds do not cover the network fee')
  await tx.sign()
  const atomicBeef = tx.toAtomicBEEF()
  return {
    txid: tx.id('hex'),
    atomicBeef,
    atomicBeefB64: Utils.toBase64(atomicBeef),
    satoshis,
    derivationPrefix,
    derivationSuffix,
  }
}

/**
 * Move every tracked output back into this wallet. Stop the server first: a
 * spend it signs concurrently makes the miner reject one of the two.
 */
export async function recoverServerWallet(): Promise<{ txid: string; satoshis: number }> {
  const runtime = requireWalletRuntime()
  const active = runtime.instance
  const owner = accountKeyScopeFor(active)
  const plan = planServerWalletRecover(requireLedger(owner))
  const chart = createActor(serverWalletRecoverMachine).start()
  chart.send({ type: 'START', plan })
  try {
    if (chart.getSnapshot().matches('failed')) {
      throw new Error(
        plan.path === 'refuse' && plan.reason === 'uneconomical'
          ? 'Tracked funds do not cover the network fee'
          : 'Nothing is tracked to recover',
      )
    }
    let pending: PendingServerRecover
    if (plan.path === 'recover') {
      const signed = await signRecover(active, plan.outputs)
      chart.send({ type: 'SIGNED', txid: signed.txid })
      assertRuntimeCurrent(runtime)
      const { registerSignedSend, startSignedSendPropagation } = await import(
        './signedSendLifecycle'
      )
      const handle = await registerSignedSend({
        txid: signed.txid,
        atomicBeef: signed.atomicBeef,
        flow: 'server_wallet_recover',
        satoshis: signed.satoshis,
        to: active.address,
      })
      const { atomicBeef: _bytes, ...rest } = signed
      pending = rest
      const spent = new Set(plan.outputs.map((out) => out.outpoint))
      const ledger = requireLedger(owner)
      writeLedger(owner, {
        ...ledger,
        outputs: ledger.outputs.filter((out) => !spent.has(out.outpoint)),
        pendingRecover: pending,
      })
      startSignedSendPropagation(handle)
      chart.send({ type: 'REGISTERED' })
    } else if (plan.path === 'finish') {
      pending = plan.pending
    } else {
      throw new Error('Recover plan was not classified')
    }

    const { withVisibleOnChainBeef } = await import('./legacyBeef')
    await withVisibleOnChainBeef(() =>
      active.wallet.internalizeAction({
        tx: Utils.toArray(pending.atomicBeefB64, 'base64'),
        description: 'Recover server wallet',
        labels: ['handcash-server-wallet'],
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: pending.derivationPrefix,
              derivationSuffix: pending.derivationSuffix,
              senderIdentityKey: active.identityKey,
            },
          },
        ],
        seekPermission: false,
      }),
    )
    writeLedger(owner, { ...requireLedger(owner), pendingRecover: null })
    chart.send({ type: 'INTERNALIZED' })
    console.info(`[server-wallet] recovered ${pending.satoshis} sats txid=${pending.txid.slice(0, 12)}`)
    const { refreshSpendableBalance } = await import('./spendGuard')
    void refreshSpendableBalance().catch(() => {})
    const { scheduleHistoryBackupPush } = await import('./deviceSync')
    scheduleHistoryBackupPush('server-wallet-recover')
    return { txid: pending.txid, satoshis: pending.satoshis }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    chart.send({ type: 'FAIL', error: reason })
    console.warn(`[server-wallet] recover failed — ${reason}`)
    throw error
  } finally {
    chart.stop()
  }
}
