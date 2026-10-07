/**
 * Developer keys — keys this account hands to a developer's server, each with
 * the capabilities chosen when it was generated: sign, wallet, or both.
 *
 * Sign: the key is `identity-<seq>` of the identity this account presents, a
 * BRC-42 `self` child of the identity master under `[1,'sigma']`. It reveals
 * neither the master nor any funds key. BAP allows one current signing key per
 * identity, so one key at a time can sign; rotating on Identity retires it and
 * frees the slot. The root (`identity-0`) never leaves the wallet.
 *
 * Wallet: the server runs a stock Toolbox wallet from `SERVER_PRIVATE_KEY` +
 * `WALLET_STORAGE_URL`; this wallet opens the same key against the same
 * storage, so both read one set of outputs and no report protocol exists.
 * Those outputs are outside this account's localState: not in the balance, not
 * selectable by a send, not swept by Refresh. Fund is a BRC-29 payment
 * internalized into that storage, behind the payment approval prompt. Recover
 * is the server wallet paying this one by BRC-29, money only; items and tokens
 * are counted and stay with the server.
 *
 * A key without Sign is a BRC-42 `self` child of the account root under
 * `[2, 'handcash server wallet']`, keyID = its number.
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
import { presentedIdentityKeyAt, presentedIdentityMaterial } from './publicIdentities'
import { BRC29_PROTOCOL_ID } from './sendBrc29Payment'
import type { ActiveWallet } from './session'
import { serverWalletRecoverMachine } from './serverWalletRecoverMachine'
import { BSV21_BASKET, tokenIdFromBsv21Tags } from './token/types'
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

export function defaultDevWalletStorageUrl(chain: ActiveWallet['chain']): string {
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
}

export type DevKeyLedger = { v: 3; next: number; keys: DevKeyRecord[] }

export type DevWalletSummary = {
  /** Spendable sats in the server's `default` basket. */
  money: number
  moneyOutputs: number
  items: number
  /** Distinct BSV-21 token ids. */
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
  | 'no-capability'
  | 'not-published'
  | 'revoked'
  | 'root-key'
  | 'sign-key-held'
  | 'unreachable'
  | 'still-signing'
  | 'not-empty'
  | 'pending'

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
    storageUrl: (raw.v === 2 && raw.storageUrl) || defaultDevWalletStorageUrl(active.chain),
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

/** The identity signing key a new Sign key would carry, or why there is none. */
export type DevSignEligibility =
  | { kind: 'ready'; bapId: string; name: string; seq: number }
  | { kind: 'refused'; reason: DevKeyRefusal; message: string }

function signEligibility(runtime: WalletRuntime, keys: DevKeyRecord[]): DevSignEligibility {
  const material = presentedIdentityMaterial(runtime)
  if (!material) return { kind: 'refused', reason: 'not-published', message: 'Publish an identity to sign.' }
  if (material.kind === 'withdrawn') {
    return { kind: 'refused', reason: 'revoked', message: 'This account no longer shares an identity.' }
  }
  const current = material.identity.keys.at(-1)
  if (!current || current.seq < 1) {
    return { kind: 'refused', reason: 'root-key', message: 'The identity root key never leaves the wallet.' }
  }
  const { bapId, name } = material.identity
  const holder = keys.find(
    (k) => k.material.kind === 'bap' && k.material.bapId === bapId && k.material.seq === current.seq,
  )
  if (holder) {
    return {
      kind: 'refused',
      reason: 'sign-key-held',
      message: `Key ${holder.n} already holds ${name}’s signing key — an identity signs with one key at a time. Give another server Key ${holder.n}’s config, or rotate the identity key to issue a new one.`,
    }
  }
  return { kind: 'ready', bapId, name, seq: current.seq }
}

export function devSignEligibility(runtime: WalletRuntime): DevSignEligibility {
  return signEligibility(runtime, readDevKeyLedger(runtime.instance).keys)
}

function signOf(runtime: WalletRuntime, material: Extract<DevKeyMaterial, { kind: 'bap' }>) {
  const presented = presentedIdentityMaterial(runtime)
  const identity =
    presented?.kind === 'presented' && presented.identity.bapId === material.bapId ? presented.identity : null
  const active = !!identity && !identity.revoked && identity.keys.at(-1)?.seq === material.seq
  return {
    bapId: material.bapId,
    seq: material.seq,
    name: identity?.name ?? null,
    state: active ? ('active' as const) : ('retired' as const),
  }
}

export function generateDevKey(
  runtime: WalletRuntime,
  capabilities: { sign: boolean; wallet: boolean },
): number {
  if (!capabilities.sign && !capabilities.wallet) {
    refuse('no-capability', 'Choose what the key can do.')
  }
  const active = runtime.instance
  const ledger = readDevKeyLedger(active)
  let material: DevKeyMaterial = { kind: 'derived' }
  if (capabilities.sign) {
    const sign = signEligibility(runtime, ledger.keys)
    if (sign.kind === 'refused') refuse(sign.reason, sign.message)
    material = { kind: 'bap', bapId: sign.bapId, seq: sign.seq }
  }
  const n = ledger.next
  writeLedger(accountKeyScopeFor(active), {
    v: 3,
    next: n + 1,
    keys: [
      ...ledger.keys,
      {
        n,
        material,
        wallet: capabilities.wallet
          ? { storageUrl: defaultDevWalletStorageUrl(active.chain), pendingFunds: [], pendingRecover: null }
          : null,
        createdAt: Date.now(),
      },
    ],
  })
  console.info(
    `[dev-key] generated key=${n}${capabilities.sign ? ' sign' : ''}${capabilities.wallet ? ' wallet' : ''}`,
  )
  return n
}

/** The env a BSVA server template reads. Only an explicit user export should call this. */
export function exportDevKeyConfig(runtime: WalletRuntime, n: number): string {
  const active = runtime.instance
  const record = requireRecord(active, n)
  const key = requireKey(runtime, record)
  console.info(`[dev-key] exported key=${n}`)
  return [
    `SERVER_PRIVATE_KEY=${key.toHex()}`,
    ...(record.wallet ? [`WALLET_STORAGE_URL=${record.wallet.storageUrl}`] : []),
    `BSV_NETWORK=${active.chain === 'main' ? 'main' : 'test'}`,
    ...(record.material.kind === 'bap' ? [`BAP_ID=${record.material.bapId}`] : []),
    '',
  ].join('\n')
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
        import('@bsv/wallet-toolbox-client'),
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
    wallet.listOutputs({ basket: '1sat', limit: 1 }),
    listAll(wallet, BSV21_BASKET, true),
  ])
  const tokenIds = new Set<string>()
  for (const out of tokens) {
    const id = tokenIdFromBsv21Tags(out.tags)
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
