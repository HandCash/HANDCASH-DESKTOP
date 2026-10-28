/**
 * Developer keys — a server wallet key (isolated balance) plus a revocable
 * BRC-52 certificate that authorizes it (BRC-100 prove / relinquish).
 *
 * New keys never receive the identity signing key. Instead the wallet issues a
 * certificate (subject = server pubkey, certifier = presented identity or
 * account root). Revoke retires the certificate without emptying the wallet.
 *
 * Legacy Sign keys (`material.kind === 'bap'`) remain listable until rotated.
 *
 * Wallet: Toolbox from `SERVER_PRIVATE_KEY` + `WALLET_STORAGE_URL`; outputs are
 * outside this account's localState. Fund is BRC-29 into that storage; Recover
 * pays this wallet back (money only).
 *
 * Derived keys are BRC-42 `self` children under `[2, 'handcash server wallet']`.
 */
import {
  CachedKeyDeriver,
  createNonce,
  KeyDeriver,
  P2PKH,
  PrivateKey,
  PublicKey,
  Utils,
  type WalletInterface,
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
import { approveWalletPayment } from './permissions'
import {
  issueDevServerCertificate,
  serializeDevServerCertificate,
  type DevServerCertificate,
} from './devServerCertificate'
import { presentedBapMaterial, presentedIdentityKeyAt } from './publicIdentities'
import { BRC29_PROTOCOL_ID } from './sendBrc29Payment'
import type { ActiveWallet } from './session'
import { serverWalletRecoverMachine } from './serverWalletRecoverMachine'
import { ITEM_STORAGE_BASKET, TOKEN_BASKET, tokenIdFromFilingTags } from './assetBaskets'
import {
  registerWalletRuntimeLifecycle,
  requireWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

export const DEV_KEY_PROTOCOL: WalletProtocol = [2, 'handcash server wallet']
/** Toolbox `defaultOptions().feeModel`. */
const FEE_SAT_PER_KB = 100
const PAGE = 1000

const KEY = storageRegistry.devKeys.key

/** HandCash's own Toolbox storage server (BRC-CLOUD workers/handcash-wallet-storage), for new keys. */
export function defaultDevWalletStorageUrl(chain: ActiveWallet['chain']): string {
  return `https://handcash-wallet-storage${chain === 'main' ? '' : '-test'}.bcryderman.workers.dev`
}

/**
 * Where a v1 or v2 server wallet that saved no storage URL was opened. Its
 * outputs are there, so migration must not move it to the new default.
 */
function babbageDevWalletStorageUrl(chain: ActiveWallet['chain']): string {
  return `https://${chain === 'main' ? '' : 'staging-'}storage.babbage.systems`
}

/** A funding payment not yet internalized into the server's storage. */
export type PendingDevFund = {
  txid: string
  outputIndex: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}

/** A recovery the server wallet broadcast that this wallet has not yet internalized. */
export type PendingDevRecover = {
  txid: string
  atomicBeefB64: string
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}

export type DevKeyMaterial =
  | { kind: 'derived' }
  | { kind: 'bap'; bapId: string; seq: number }

export type DevKeyWallet = {
  storageUrl: string
  pendingFunds: PendingDevFund[]
  pendingRecover: PendingDevRecover | null
}

export type DevKeyRecord = {
  /** Shown as "Key <n>"; a derived key's keyID. Never reused. */
  n: number
  material: DevKeyMaterial
  wallet: DevKeyWallet | null
  createdAt: number
  /** BRC-52 authorization for the server key; absent on legacy rows. */
  certificate?: DevServerCertificate | null
  /** Set when the certificate is revoked; export omits the cert. */
  revokedAt?: number | null
}

export type DevKeyLedger = { v: 3; next: number; keys: DevKeyRecord[] }

export type DevWalletSummary = {
  /** Spendable sats in the server's `default` basket. */
  money: number
  moneyOutputs: number
  items: number
  /** Distinct token ids. */
  tokens: number
}

/**
 * What can be said about a key's wallet right now. `settling` = a fund payment
 * not yet internalized into the server's storage, or a recovery not yet
 * internalized here; the summary excludes it until it lands.
 */
export type DevWalletStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: DevWalletSummary }
  | { kind: 'settling'; summary: DevWalletSummary | null; funding: number; recovering: number }
  | { kind: 'unreachable'; summary: DevWalletSummary | null; error: string }

export type DevKeyView = {
  n: number
  /** Null while a sign key's identity is not the one presented. */
  publicKey: string | null
  /** 0 for a key migrated from a ledger that did not record it. */
  createdAt: number
  sign: null | {
    bapId: string
    seq: number
    /** Null while another identity is presented. */
    name: string | null
    state: 'active' | 'retired'
  }
  /** BRC-52 server authorization; null when legacy, missing, or revoked. */
  certificate: null | {
    serialNumber: string
    certifier: string
    state: 'active' | 'revoked'
  }
  wallet: null | {
    status: DevWalletStatus
    /** Host of the Toolbox storage the server and this wallet both open. */
    storageHost: string
    refreshing: boolean
  }
}

export function devWalletStatus(
  wallet: Pick<DevKeyWallet, 'pendingFunds' | 'pendingRecover'>,
  read: { summary: DevWalletSummary | null; error: string | null } | undefined,
  refreshing: boolean,
): DevWalletStatus {
  const summary = read?.summary ?? null
  if (read?.error && !refreshing) return { kind: 'unreachable', summary, error: read.error }
  const funding = wallet.pendingFunds.reduce((sum, fund) => sum + fund.satoshis, 0)
  const recovering = wallet.pendingRecover?.satoshis ?? 0
  if (wallet.pendingFunds.length > 0 || wallet.pendingRecover) {
    return { kind: 'settling', summary, funding, recovering }
  }
  return summary ? { kind: 'ready', summary } : { kind: 'loading' }
}

export function devWalletHoldings(status: DevWalletStatus): DevWalletSummary | null {
  return status.kind === 'loading' ? null : status.summary
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export type DevKeyRefusal =
  | 'unreachable'
  | 'still-signing'
  | 'not-empty'
  | 'pending'
  | 'already-revoked'
  | 'no-certificate'

export class DevKeyRefused extends Error {
  constructor(
    readonly reason: DevKeyRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'DevKeyRefused'
  }
}

function refuse(reason: DevKeyRefusal, message: string): never {
  console.warn(`[dev-key] refused ${reason}`)
  throw new DevKeyRefused(reason, message)
}

export type DevWalletRecoverRefusal = 'nothing-to-recover' | 'uneconomical'

export type DevWalletRecoverPlan =
  | { path: 'recover'; satoshis: number }
  | { path: 'finish'; pending: PendingDevRecover }
  | { path: 'refuse'; reason: DevWalletRecoverRefusal }

// ── ledger ─────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let revision = 0

export function subscribeDevKeys(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function devKeysRevision(): number {
  return revision
}

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

type V1Ledger = {
  v: 1
  generation: number
  outputs?: Array<{
    outpoint?: string
    satoshis?: number
    generation?: number
    lock?: { kind?: string; derivationPrefix?: string; derivationSuffix?: string; sender?: string }
  }>
  pendingRecover?: PendingDevRecover | null
}

type V2Ledger = {
  v: 2
  generation: number
  storageUrl?: string
  pendingFunds?: PendingDevFund[]
  pendingRecover?: PendingDevRecover | null
}

/**
 * v1 tracked outputs from messagebox reports. Its fund payments are BRC-29
 * outputs from this identity, which become pending internalizations into the
 * server's storage; anything else it tracked was the server's own and is
 * already in that storage.
 */
function v1Funds(raw: V1Ledger, active: ActiveWallet): PendingDevFund[] {
  const sender = active.identityKey.toLowerCase()
  const funds: PendingDevFund[] = []
  for (const out of raw.outputs ?? []) {
    const [txid = '', vout] = (out.outpoint ?? '').split('.')
    const lock = out.lock
    if (
      out.generation !== raw.generation ||
      lock?.kind !== 'brc29' ||
      lock.sender?.toLowerCase() !== sender ||
      !lock.derivationPrefix ||
      !lock.derivationSuffix ||
      !/^[0-9a-f]{64}$/.test(txid) ||
      !Number.isInteger(Number(vout))
    ) {
      continue
    }
    funds.push({
      txid,
      outputIndex: Number(vout),
      satoshis: out.satoshis ?? 0,
      derivationPrefix: lock.derivationPrefix,
      derivationSuffix: lock.derivationSuffix,
    })
  }
  return funds
}

/** v1/v2 held one server wallet at keyID = generation: it is that numbered key. */
function migrate(raw: V1Ledger | V2Ledger, active: ActiveWallet): DevKeyLedger {
  const wallet: DevKeyWallet = {
    storageUrl: (raw.v === 2 && raw.storageUrl) || babbageDevWalletStorageUrl(active.chain),
    pendingFunds:
      raw.v === 1 ? v1Funds(raw, active) : Array.isArray(raw.pendingFunds) ? raw.pendingFunds : [],
    pendingRecover: raw.pendingRecover ?? null,
  }
  return {
    v: 3,
    next: raw.generation + 1,
    keys: [{ n: raw.generation, material: { kind: 'derived' }, wallet, createdAt: 0 }],
  }
}

export function readDevKeyLedger(active: ActiveWallet): DevKeyLedger {
  const empty: DevKeyLedger = { v: 3, next: 1, keys: [] }
  const raw = durableGetItem(accountLocalKeyFor(KEY, accountKeyScopeFor(active)))
  if (!raw) return empty
  try {
    const parsed = JSON.parse(raw) as DevKeyLedger | V1Ledger | V2Ledger
    if (parsed.v === 3) {
      return Array.isArray(parsed.keys) && Number.isInteger(parsed.next) ? parsed : empty
    }
    if ((parsed.v === 1 || parsed.v === 2) && Number.isInteger(parsed.generation)) {
      return migrate(parsed, active)
    }
    return empty
  } catch {
    return empty
  }
}

function writeLedger(owner: BoundAccountKeyScope, ledger: DevKeyLedger): void {
  if (!durableSetItem(accountLocalKeyFor(KEY, owner), JSON.stringify(ledger))) {
    throw new Error('Could not save developer keys')
  }
  notify()
}

function requireRecord(active: ActiveWallet, n: number): DevKeyRecord {
  const record = readDevKeyLedger(active).keys.find((k) => k.n === n)
  if (!record) throw new Error(`Key ${n} no longer exists`)
  return record
}

function requireWallet(active: ActiveWallet, n: number): DevKeyWallet {
  const wallet = requireRecord(active, n).wallet
  if (!wallet) throw new Error(`Key ${n} has no wallet`)
  return wallet
}

function updateWallet(
  active: ActiveWallet,
  n: number,
  change: (wallet: DevKeyWallet) => DevKeyWallet,
): void {
  const ledger = readDevKeyLedger(active)
  writeLedger(accountKeyScopeFor(active), {
    ...ledger,
    keys: ledger.keys.map((k) => (k.n === n && k.wallet ? { ...k, wallet: change(k.wallet) } : k)),
  })
}

// ── keys ───────────────────────────────────────────────────────────────────

export function derivedDevKey(rootKeyHex: string, n: number): PrivateKey {
  return new KeyDeriver(PrivateKey.fromHex(rootKeyHex.trim())).derivePrivateKey(
    DEV_KEY_PROTOCOL,
    String(n),
    'self',
  )
}

function privateKeyOf(runtime: WalletRuntime, record: DevKeyRecord): PrivateKey | null {
  if (record.material.kind === 'derived') return derivedDevKey(runtime.instance.rootKeyHex, record.n)
  return presentedIdentityKeyAt(runtime, record.material.bapId, record.material.seq)
}

function requireKey(runtime: WalletRuntime, record: DevKeyRecord): PrivateKey {
  const key = privateKeyOf(runtime, record)
  if (!key) refuse('unreachable', `Present the identity Key ${record.n} signs as to use it.`)
  return key
}

function signOf(runtime: WalletRuntime, material: Extract<DevKeyMaterial, { kind: 'bap' }>) {
  const presented = presentedBapMaterial(runtime)
  const identity = presented.kind !== 'none' && presented.identity.bapId === material.bapId ? presented.identity : null
  const active = !!identity && !identity.revoked && identity.keys.at(-1)?.seq === material.seq
  return {
    bapId: material.bapId,
    seq: material.seq,
    name: identity?.name ?? null,
    state: active ? ('active' as const) : ('retired' as const),
  }
}

/** A new server wallet key + revocable BRC-52 certificate. Never issues a signing key. */
export async function generateDevKey(runtime: WalletRuntime): Promise<number> {
  const active = runtime.instance
  const ledger = readDevKeyLedger(active)
  const n = ledger.next
  const material: DevKeyMaterial = { kind: 'derived' }
  const wallet: DevKeyWallet = {
    storageUrl: defaultDevWalletStorageUrl(active.chain),
    pendingFunds: [],
    pendingRecover: null,
  }
  writeLedger(accountKeyScopeFor(active), {
    v: 3,
    next: n + 1,
    keys: [
      ...ledger.keys,
      { n, material, wallet, createdAt: Date.now(), certificate: null, revokedAt: null },
    ],
  })
  const subjectPublicKey = derivedDevKey(active.rootKeyHex, n).toPublicKey().toString()
  const certificate = await issueDevServerCertificate(runtime, { subjectPublicKey, keyN: n })
  const next = readDevKeyLedger(active)
  writeLedger(accountKeyScopeFor(active), {
    ...next,
    keys: next.keys.map((k) => (k.n === n ? { ...k, certificate } : k)),
  })
  console.info(`[dev-key] generated key=${n} wallet+certificate`)
  return n
}

/** The env a BSVA server template reads. Only an explicit user export should call this. */
export function exportDevKeyConfig(runtime: WalletRuntime, n: number): string {
  const active = runtime.instance
  const record = requireRecord(active, n)
  const key = requireKey(runtime, record)
  console.info(`[dev-key] exported key=${n}`)
  const lines = [
    `SERVER_PRIVATE_KEY=${key.toHex().padStart(64, '0')}`,
    ...(record.wallet ? [`WALLET_STORAGE_URL=${record.wallet.storageUrl}`] : []),
    `BSV_NETWORK=${active.chain === 'main' ? 'main' : 'test'}`,
  ]
  if (record.material.kind === 'bap') lines.push(`BAP_ID=${record.material.bapId}`)
  if (record.certificate && !record.revokedAt) {
    lines.push(`SERVER_CERTIFICATE=${serializeDevServerCertificate(record.certificate)}`)
  }
  return [...lines, ''].join('\n')
}

/** Retire the BRC-52 certificate; the isolated wallet balance is unchanged. */
export function revokeDevKeyCertificate(runtime: WalletRuntime, n: number): void {
  const active = runtime.instance
  const record = requireRecord(active, n)
  if (!record.certificate) refuse('no-certificate', `Key ${n} has no certificate to revoke.`)
  if (record.revokedAt) refuse('already-revoked', `Key ${n}'s certificate is already revoked.`)
  const ledger = readDevKeyLedger(active)
  writeLedger(accountKeyScopeFor(active), {
    ...ledger,
    keys: ledger.keys.map((k) =>
      k.n === n ? { ...k, revokedAt: Date.now() } : k,
    ),
  })
  console.info(`[dev-key] revoked certificate key=${n}`)
}

/**
 * Forget a key. Refused while it can still sign (only a rotation retires it,
 * forgetting would not) or while its wallet holds anything.
 */
export async function removeDevKey(runtime: WalletRuntime, n: number): Promise<void> {
  const active = runtime.instance
  const record = requireRecord(active, n)
  if (record.material.kind === 'bap' && signOf(runtime, record.material).state === 'active') {
    refuse('still-signing', `Key ${n} still signs. Rotate the identity key to retire it first.`)
  }
  if (record.wallet) {
    if (record.wallet.pendingFunds.length > 0 || record.wallet.pendingRecover) {
      refuse('pending', `Finish Key ${n}'s pending payment first.`)
    }
    const summary = await refreshDevWallet(runtime, n)
    if (summary.money > 0 || summary.items > 0 || summary.tokens > 0) {
      refuse('not-empty', `Empty Key ${n}'s wallet first.`)
    }
  }
  const ledger = readDevKeyLedger(active)
  writeLedger(accountKeyScopeFor(active), { ...ledger, keys: ledger.keys.filter((k) => k.n !== n) })
  console.info(`[dev-key] removed key=${n}`)
}

// ── the server's wallet ────────────────────────────────────────────────────

const opened = new Map<string, Promise<WalletInterface>>()
const summaries = new Map<string, { summary: DevWalletSummary | null; error: string | null }>()
const refreshing = new Map<string, Promise<DevWalletSummary>>()
let lifecycleRegistered = false
let queue: Promise<unknown> = Promise.resolve()

/**
 * One storage mutation at a time: a pending fund settled by a refresh and by
 * the Fund that recorded it must not internalize twice.
 */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

function slot(active: ActiveWallet, n: number, wallet: DevKeyWallet): string {
  return `${active.chain}:${active.identityKey}:${n}:${wallet.storageUrl}`
}

/** The opened wallet holds the server key; it does not outlive an unlock. */
function registerLifecycle(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  registerWalletRuntimeLifecycle({
    name: 'dev-keys',
    dispose: (_runtime, reason) => {
      if (reason !== 'locked' && reason !== 'test') return
      opened.clear()
      summaries.clear()
    },
  })
}

/**
 * The same Toolbox wallet the server runs: same key, same storage. Built on
 * this session's services, whose fetch is bound for the platform — the
 * Toolbox's own default stores a bare `fetch` that Android WebView refuses
 * with "Illegal invocation".
 */
async function openDevWallet(runtime: WalletRuntime, n: number): Promise<WalletInterface> {
  registerLifecycle()
  const active = runtime.instance
  const record = requireRecord(active, n)
  const config = requireWallet(active, n)
  const key = slot(active, n, config)
  let wallet = opened.get(key)
  if (!wallet) {
    const rootKey = requireKey(runtime, record)
    const started = Date.now()
    wallet = (async () => {
      const [{ Wallet, WalletStorageManager, StorageClient }, { walletCryptoBackend }] = await Promise.all([
        import('@handcash/wallet-engine'),
        import('./cryptoBackend'),
      ])
      const keyDeriver = new CachedKeyDeriver(rootKey)
      const storage = new WalletStorageManager(keyDeriver.identityKey)
      const server = new Wallet({
        chain: active.chain,
        keyDeriver,
        storage,
        services: active.services,
        scriptVerifier: walletCryptoBackend(active.chain),
        actionBatchMode: 'legacy',
      })
      await storage.addWalletStorageProvider(new StorageClient(server, config.storageUrl))
      await storage.makeAvailable()
      const ms = Date.now() - started
      if (ms >= 250) console.info(`[dev-key] open done ${ms}ms`)
      return server as WalletInterface
    })()
    opened.set(key, wallet)
    wallet.catch(() => opened.delete(key))
  }
  return wallet
}

async function listAll(
  wallet: WalletInterface,
  basket: string,
  includeTags = false,
): Promise<Array<{ satoshis: number; tags?: string[] }>> {
  const all: Array<{ satoshis: number; tags?: string[] }> = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await wallet.listOutputs({
      basket,
      limit: PAGE,
      offset,
      ...(includeTags ? { includeTags: true } : {}),
    })
    all.push(...page.outputs)
    if (page.outputs.length < PAGE || all.length >= page.totalOutputs) return all
  }
}

export async function summarizeDevWallet(wallet: WalletInterface): Promise<DevWalletSummary> {
  const [money, items, tokens] = await Promise.all([
    listAll(wallet, 'default'),
    wallet.listOutputs({ basket: ITEM_STORAGE_BASKET, limit: 1 }),
    listAll(wallet, TOKEN_BASKET, true),
  ])
  const tokenIds = new Set<string>()
  for (const out of tokens) {
    const id = tokenIdFromFilingTags(out.tags)
    if (id) tokenIds.add(id)
  }
  return {
    money: money.reduce((sum, out) => sum + out.satoshis, 0),
    moneyOutputs: money.length,
    items: items.totalOutputs,
    tokens: tokenIds.size,
  }
}

export function listDevKeys(runtime: WalletRuntime): DevKeyView[] {
  const active = runtime.instance
  return readDevKeyLedger(active).keys.map((record) => {
    const key = record.wallet ? slot(active, record.n, record.wallet) : null
    const refreshingNow = key != null && refreshing.has(key)
    return {
      n: record.n,
      publicKey: privateKeyOf(runtime, record)?.toPublicKey().toString() ?? null,
      createdAt: record.createdAt,
      sign: record.material.kind === 'bap' ? signOf(runtime, record.material) : null,
      certificate: record.certificate
        ? {
            serialNumber: record.certificate.serialNumber,
            certifier: record.certificate.certifier,
            state: record.revokedAt ? ('revoked' as const) : ('active' as const),
          }
        : null,
      wallet:
        record.wallet && key
          ? {
              status: devWalletStatus(record.wallet, summaries.get(key), refreshingNow),
              storageHost: hostOf(record.wallet.storageUrl),
              refreshing: refreshingNow,
            }
          : null,
    }
  })
}

/**
 * Re-read a key's server storage. Settles pending fund payments first so a
 * funding the server cannot see yet is not left out of the count.
 */
export function refreshDevWallet(runtime: WalletRuntime, n: number): Promise<DevWalletSummary> {
  const active = runtime.instance
  const key = slot(active, n, requireWallet(active, n))
  const inFlight = refreshing.get(key)
  if (inFlight) return inFlight
  const run = exclusive(async () => {
    try {
      const wallet = await openDevWallet(runtime, n)
      await settlePendingFunds(active, n, wallet)
      const summary = await summarizeDevWallet(wallet)
      summaries.set(key, { summary, error: null })
      return summary
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      summaries.set(key, { summary: summaries.get(key)?.summary ?? null, error: reason })
      console.warn(`[dev-key] refresh failed — ${reason}`)
      throw error
    } finally {
      refreshing.delete(key)
      notify()
    }
  })
  refreshing.set(key, run)
  notify()
  return run
}

// ── fund ───────────────────────────────────────────────────────────────────

async function internalizeFund(
  active: ActiveWallet,
  n: number,
  wallet: WalletInterface,
  fund: PendingDevFund,
  atomicBeef?: number[],
): Promise<void> {
  const same = (p: PendingDevFund) => p.txid === fund.txid && p.outputIndex === fund.outputIndex
  if (!requireWallet(active, n).pendingFunds.some(same)) return
  const { atomicBeefForSubject, getBeefForTxidCached } = await import('./beefCache')
  const tx =
    atomicBeefForSubject(atomicBeef, fund.txid) ??
    atomicBeefForSubject((await getBeefForTxidCached(active, fund.txid)).toBinary(), fund.txid)
  if (!tx) throw new Error(`Could not load funding transaction ${fund.txid.slice(0, 12)}`)
  await wallet.internalizeAction({
    tx,
    description: 'Funded from HandCash',
    outputs: [
      {
        outputIndex: fund.outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: fund.derivationPrefix,
          derivationSuffix: fund.derivationSuffix,
          senderIdentityKey: active.identityKey,
        },
      },
    ],
  })
  updateWallet(active, n, (current) => ({
    ...current,
    pendingFunds: current.pendingFunds.filter((p) => !same(p)),
  }))
  console.info(`[dev-key] fund ${fund.txid.slice(0, 12)} internalized ${fund.satoshis} sats key=${n}`)
}

async function settlePendingFunds(active: ActiveWallet, n: number, wallet: WalletInterface): Promise<void> {
  for (const fund of requireWallet(active, n).pendingFunds) {
    await internalizeFund(active, n, wallet, fund)
  }
}

/**
 * Approved BRC-29 payment to the key's identity, then internalized into its
 * storage. The payment is recorded before internalizing; a miss retries on the
 * next refresh.
 */
export async function fundDevWallet(n: number, satoshis: number): Promise<{ txid: string }> {
  const runtime = requireWalletRuntime()
  const active = runtime.instance
  requireWallet(active, n)
  const payee = requireKey(runtime, requireRecord(active, n)).toPublicKey().toString()
  await approveWalletPayment({
    title: 'Fund dev wallet',
    summary: `Key ${n}`,
    amountSats: satoshis,
    details: ['Spent only by the server running this key'],
  })
  const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
  const result = await sendBrc29ToIdentityKey({
    payeeIdentityKey: payee,
    satoshis,
    friendLabel: `Dev key ${n}`,
    description: 'Fund dev wallet',
  })
  const fund: PendingDevFund = {
    txid: result.txid.toLowerCase(),
    outputIndex: result.remittance.outputIndex ?? 0,
    satoshis,
    derivationPrefix: result.remittance.derivationPrefix,
    derivationSuffix: result.remittance.derivationSuffix,
  }
  updateWallet(active, n, (current) => ({ ...current, pendingFunds: [...current.pendingFunds, fund] }))
  console.info(`[dev-key] funded ${satoshis} sats ${fund.txid.slice(0, 12)}.${fund.outputIndex} key=${n}`)
  try {
    await exclusive(async () =>
      internalizeFund(active, n, await openDevWallet(runtime, n), fund, result.atomicBeef),
    )
  } catch (error) {
    console.warn(
      `[dev-key] fund ${fund.txid.slice(0, 12)} internalize deferred — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  void refreshDevWallet(runtime, n).catch(() => {})
  return { txid: fund.txid }
}

// ── recover ────────────────────────────────────────────────────────────────

/** Fee the server's funding needs: every money input plus payment and change. */
function recoverFee(moneyOutputs: number): number {
  return Math.ceil(((10 + 148 * moneyOutputs + 34 * 2) * FEE_SAT_PER_KB) / 1000)
}

export function planDevWalletRecover(
  wallet: Pick<DevKeyWallet, 'pendingRecover'>,
  summary: Pick<DevWalletSummary, 'money' | 'moneyOutputs'>,
): DevWalletRecoverPlan {
  if (wallet.pendingRecover) return { path: 'finish', pending: wallet.pendingRecover }
  if (summary.money <= 0) return { path: 'refuse', reason: 'nothing-to-recover' }
  const satoshis = summary.money - recoverFee(summary.moneyOutputs)
  if (satoshis < 1) return { path: 'refuse', reason: 'uneconomical' }
  return { path: 'recover', satoshis }
}

/** The server wallet pays this one by BRC-29; it signs and broadcasts. */
async function spendRecover(
  active: ActiveWallet,
  server: WalletInterface,
  satoshis: number,
): Promise<PendingDevRecover> {
  const [derivationPrefix, derivationSuffix] = await Promise.all([
    createNonce(server, 'self'),
    createNonce(server, 'self'),
  ])
  const { publicKey } = await server.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: active.identityKey,
  })
  const pay = (amount: number) =>
    server.createAction({
      description: 'Recover to HandCash',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex(),
          satoshis: amount,
          outputDescription: 'Recover to HandCash',
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            payee: active.identityKey,
          }),
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    })
  // The storage prices the fee, not this wallet: the estimate opens the bid
  // and its exact shortfall settles it.
  let amount = satoshis
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await pay(amount)
      if (!result.txid || !result.tx) throw new Error('Server wallet did not return the signed recovery')
      return {
        txid: result.txid,
        atomicBeefB64: Utils.toBase64(result.tx),
        satoshis: amount,
        derivationPrefix,
        derivationSuffix,
      }
    } catch (error) {
      const short = feeShortfall(error)
      if (short == null || attempt >= 3 || amount - short < 1) throw error
      console.info(`[dev-key] recover fee short ${short} sats — paying ${amount - short}`)
      amount -= short
    }
  }
}

/** Sats a Toolbox `WERR_INSUFFICIENT_FUNDS` says are missing, local or over storage RPC. */
export function feeShortfall(error: unknown): number | null {
  const more = (error as { moreSatoshisNeeded?: unknown } | null)?.moreSatoshisNeeded
  if (typeof more === 'number' && more > 0) return more
  const m = /(\d+) more satoshis are needed/.exec(error instanceof Error ? error.message : String(error))
  return m ? Number(m[1]) : null
}

/**
 * Move a key's wallet money back into this wallet. Items and tokens stay with
 * the server. Stop the server first: a spend it makes concurrently can take
 * the same coins.
 */
export function recoverDevWallet(n: number): Promise<{ txid: string; satoshis: number }> {
  const runtime = requireWalletRuntime()
  return exclusive(() => recoverExclusive(runtime, n))
}

async function recoverExclusive(
  runtime: WalletRuntime,
  n: number,
): Promise<{ txid: string; satoshis: number }> {
  const active = runtime.instance
  const config = requireWallet(active, n)
  const server = await openDevWallet(runtime, n)
  const plan = planDevWalletRecover(
    config,
    config.pendingRecover ? { money: 0, moneyOutputs: 0 } : await summarizeDevWallet(server),
  )
  const chart = createActor(serverWalletRecoverMachine).start()
  chart.send({ type: 'START', plan })
  try {
    if (plan.path === 'refuse') {
      throw new Error(
        plan.reason === 'uneconomical'
          ? 'Its money does not cover the network fee'
          : 'Its wallet holds no money',
      )
    }
    let pending: PendingDevRecover
    if (plan.path === 'recover') {
      pending = await spendRecover(active, server, plan.satoshis)
      updateWallet(active, n, (current) => ({ ...current, pendingRecover: pending }))
      chart.send({ type: 'SPENT', txid: pending.txid })
    } else {
      pending = plan.pending
    }

    const sender = requireKey(runtime, requireRecord(active, n)).toPublicKey().toString()
    const { withVisibleOnChainBeef } = await import('./legacyBeef')
    await withVisibleOnChainBeef(() =>
      active.wallet.internalizeAction({
        tx: Utils.toArray(pending.atomicBeefB64, 'base64'),
        description: 'Recover dev wallet',
        labels: ['handcash-server-wallet'],
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: pending.derivationPrefix,
              derivationSuffix: pending.derivationSuffix,
              senderIdentityKey: sender,
            },
          },
        ],
        seekPermission: false,
      }),
    )
    updateWallet(active, n, (current) => ({ ...current, pendingRecover: null }))
    chart.send({ type: 'INTERNALIZED' })
    console.info(`[dev-key] recovered ${pending.satoshis} sats txid=${pending.txid.slice(0, 12)} key=${n}`)
    const { refreshSpendableBalance } = await import('./spendGuard')
    void refreshSpendableBalance().catch(() => {})
    const { scheduleHistoryBackupPush } = await import('./deviceSync')
    scheduleHistoryBackupPush('server-wallet-recover')
    void refreshDevWallet(runtime, n).catch(() => {})
    return { txid: pending.txid, satoshis: pending.satoshis }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    chart.send({ type: 'FAIL', error: reason })
    console.warn(`[dev-key] recover failed — ${reason}`)
    throw error
  } finally {
    chart.stop()
  }
}
