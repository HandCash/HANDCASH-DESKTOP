/**
 * Server wallet — a stock BRC-100 wallet a developer's server runs, which this
 * wallet opens too.
 *
 * Custody: the server's root key is a BRC-42 self child of the account root
 * under `[2, 'handcash server wallet']`, keyID = generation. The server runs a
 * Toolbox wallet from `SERVER_PRIVATE_KEY` + `WALLET_STORAGE_URL`; this wallet
 * opens the same key against the same storage, so both read one set of outputs
 * and no report protocol exists. Those outputs are outside this account's
 * localState: not in the balance, not selectable by a send, not swept by
 * Refresh.
 *
 * Fund is a BRC-29 payment internalized into the server's storage. Recover is
 * the server wallet paying this one by BRC-29, money only. Items and tokens
 * are counted and stay with the server.
 */
import {
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
import { BRC29_PROTOCOL_ID } from './sendBrc29Payment'
import type { ActiveWallet } from './session'
import { serverWalletRecoverMachine } from './serverWalletRecoverMachine'
import { BSV21_BASKET, tokenIdFromBsv21Tags } from './token/types'
import {
  registerWalletRuntimeLifecycle,
  requireWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

export const SERVER_WALLET_PROTOCOL: WalletProtocol = [2, 'handcash server wallet']
/** Toolbox `defaultOptions().feeModel`. */
const FEE_SAT_PER_KB = 100
const PAGE = 1000

const KEY = storageRegistry.serverWallet.key

export function defaultServerWalletStorageUrl(chain: ActiveWallet['chain']): string {
  return `https://${chain === 'main' ? '' : 'staging-'}storage.babbage.systems`
}

/** A funding payment not yet internalized into the server's storage. */
export type PendingServerFund = {
  txid: string
  outputIndex: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}

/** A recovery the server wallet broadcast that this wallet has not yet internalized. */
export type PendingServerRecover = {
  txid: string
  atomicBeefB64: string
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}

export type ServerWalletLedger = {
  v: 2
  generation: number
  storageUrl: string
  pendingFunds: PendingServerFund[]
  pendingRecover: PendingServerRecover | null
}

export type ServerWalletSummary = {
  /** Spendable sats in the server's `default` basket. */
  money: number
  moneyOutputs: number
  items: number
  /** Distinct BSV-21 token ids. */
  tokens: number
}

export type ServerWalletRecoverRefusal = 'nothing-to-recover' | 'uneconomical'

export type ServerWalletRecoverPlan =
  | { path: 'recover'; satoshis: number }
  | { path: 'finish'; pending: PendingServerRecover }
  | { path: 'refuse'; reason: ServerWalletRecoverRefusal }

export type ServerWalletStatus =
  | { kind: 'off' }
  | {
      kind: 'ready'
      generation: number
      identityKey: string
      /** Null until the first read of the server's storage lands. */
      summary: ServerWalletSummary | null
      error: string | null
      pending: boolean
    }

// ── key ────────────────────────────────────────────────────────────────────

export function serverWalletKey(rootKeyHex: string, generation: number): PrivateKey {
  return new KeyDeriver(PrivateKey.fromHex(rootKeyHex.trim())).derivePrivateKey(
    SERVER_WALLET_PROTOCOL,
    String(generation),
    'self',
  )
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

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

type LegacyLedger = {
  v: 1
  generation: number
  outputs?: Array<{
    outpoint?: string
    satoshis?: number
    generation?: number
    lock?: { kind?: string; derivationPrefix?: string; derivationSuffix?: string; sender?: string }
  }>
  pendingRecover?: PendingServerRecover | null
}

/**
 * v1 tracked outputs from messagebox reports. Its fund payments are BRC-29
 * outputs from this identity, which become pending internalizations into the
 * server's storage; anything else it tracked was the server's own and is
 * already in that storage.
 */
function migrateLegacyLedger(raw: LegacyLedger, active: ActiveWallet): ServerWalletLedger {
  const sender = active.identityKey.toLowerCase()
  const pendingFunds: PendingServerFund[] = []
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
    pendingFunds.push({
      txid,
      outputIndex: Number(vout),
      satoshis: out.satoshis ?? 0,
      derivationPrefix: lock.derivationPrefix,
      derivationSuffix: lock.derivationSuffix,
    })
  }
  return {
    v: 2,
    generation: raw.generation,
    storageUrl: defaultServerWalletStorageUrl(active.chain),
    pendingFunds,
    pendingRecover: raw.pendingRecover ?? null,
  }
}

export function readServerWalletLedger(active: ActiveWallet): ServerWalletLedger | null {
  const raw = durableGetItem(accountLocalKeyFor(KEY, accountKeyScopeFor(active)))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ServerWalletLedger> | LegacyLedger
    if (!Number.isInteger(parsed.generation)) return null
    if (parsed.v === 1) return migrateLegacyLedger(parsed as LegacyLedger, active)
    if (parsed.v !== 2) return null
    const ledger = parsed as Partial<ServerWalletLedger>
    return {
      v: 2,
      generation: ledger.generation!,
      storageUrl: ledger.storageUrl || defaultServerWalletStorageUrl(active.chain),
      pendingFunds: Array.isArray(ledger.pendingFunds) ? ledger.pendingFunds : [],
      pendingRecover: ledger.pendingRecover ?? null,
    }
  } catch {
    return null
  }
}

function writeLedger(owner: BoundAccountKeyScope, ledger: ServerWalletLedger): void {
  if (!durableSetItem(accountLocalKeyFor(KEY, owner), JSON.stringify(ledger))) {
    throw new Error('Could not save the server wallet ledger')
  }
  notify()
}

function requireLedger(active: ActiveWallet): ServerWalletLedger {
  const ledger = readServerWalletLedger(active)
  if (!ledger) throw new Error('Set up the server wallet first')
  return ledger
}

function updateLedger(
  active: ActiveWallet,
  change: (ledger: ServerWalletLedger) => ServerWalletLedger,
): void {
  writeLedger(accountKeyScopeFor(active), change(requireLedger(active)))
}

// ── the server's wallet ────────────────────────────────────────────────────

const opened = new Map<string, Promise<WalletInterface>>()
const summaries = new Map<string, { summary: ServerWalletSummary | null; error: string | null }>()
const refreshing = new Map<string, Promise<ServerWalletSummary>>()
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

function slot(active: ActiveWallet, ledger: ServerWalletLedger): string {
  return `${active.chain}:${active.identityKey}:${ledger.generation}:${ledger.storageUrl}`
}

/** The opened wallet holds the server key; it does not outlive an unlock. */
function registerLifecycle(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  registerWalletRuntimeLifecycle({
    name: 'server-wallet',
    dispose: (_runtime, reason) => {
      if (reason !== 'locked' && reason !== 'test') return
      opened.clear()
      summaries.clear()
    },
  })
}

/** The same Toolbox wallet the server runs: same key, same storage. */
async function openServerWallet(
  active: ActiveWallet,
  ledger: ServerWalletLedger,
): Promise<WalletInterface> {
  registerLifecycle()
  const key = slot(active, ledger)
  let wallet = opened.get(key)
  if (!wallet) {
    const started = Date.now()
    wallet = (async () => {
      const [{ SetupClient }, { walletCryptoBackend }] = await Promise.all([
        import('@bsv/wallet-toolbox-client'),
        import('./cryptoBackend'),
      ])
      const client = await SetupClient.createWalletClientNoEnv({
        chain: active.chain,
        rootKeyHex: serverWalletKey(active.rootKeyHex, ledger.generation).toHex(),
        storageUrl: ledger.storageUrl,
        scriptVerifier: walletCryptoBackend(active.chain),
      })
      const ms = Date.now() - started
      if (ms >= 250) console.info(`[server-wallet] open done ${ms}ms`)
      return client as WalletInterface
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

export async function summarizeServerWallet(wallet: WalletInterface): Promise<ServerWalletSummary> {
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

export function describeServerWallet(runtime: WalletRuntime): ServerWalletStatus {
  const active = runtime.instance
  const ledger = readServerWalletLedger(active)
  if (!ledger) return { kind: 'off' }
  const read = summaries.get(slot(active, ledger))
  return {
    kind: 'ready',
    generation: ledger.generation,
    identityKey: serverWalletKey(active.rootKeyHex, ledger.generation).toPublicKey().toString(),
    summary: read?.summary ?? null,
    error: read?.error ?? null,
    pending: ledger.pendingFunds.length > 0 || ledger.pendingRecover != null,
  }
}

/**
 * Re-read the server's storage. Settles pending fund payments first so a
 * funding the server cannot see yet is not left out of the count.
 */
export function refreshServerWallet(runtime: WalletRuntime): Promise<ServerWalletSummary> {
  const active = runtime.instance
  const ledger = requireLedger(active)
  const key = slot(active, ledger)
  const inFlight = refreshing.get(key)
  if (inFlight) return inFlight
  const run = exclusive(async () => {
    try {
      const wallet = await openServerWallet(active, ledger)
      await settlePendingFunds(active, wallet)
      const summary = await summarizeServerWallet(wallet)
      summaries.set(key, { summary, error: null })
      return summary
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      summaries.set(key, { summary: summaries.get(key)?.summary ?? null, error: reason })
      console.warn(`[server-wallet] refresh failed — ${reason}`)
      throw error
    } finally {
      refreshing.delete(key)
      notify()
    }
  })
  refreshing.set(key, run)
  return run
}

export function setUpServerWallet(runtime: WalletRuntime): void {
  const active = runtime.instance
  if (readServerWalletLedger(active)) return
  writeLedger(accountKeyScopeFor(active), {
    v: 2,
    generation: 1,
    storageUrl: defaultServerWalletStorageUrl(active.chain),
    pendingFunds: [],
    pendingRecover: null,
  })
  console.info('[server-wallet] set up generation 1')
}

/** The env a BSVA server template reads to open this wallet. */
export function exportServerWalletConfig(runtime: WalletRuntime): string {
  const active = runtime.instance
  const ledger = requireLedger(active)
  console.info(`[server-wallet] exported generation ${ledger.generation}`)
  return [
    `SERVER_PRIVATE_KEY=${serverWalletKey(active.rootKeyHex, ledger.generation).toHex()}`,
    `WALLET_STORAGE_URL=${ledger.storageUrl}`,
    `BSV_NETWORK=${active.chain === 'main' ? 'main' : 'test'}`,
    '',
  ].join('\n')
}

/** Retire the current key. Refused while the server wallet holds anything. */
export async function rotateServerWallet(runtime: WalletRuntime): Promise<number> {
  const active = runtime.instance
  const ledger = requireLedger(active)
  if (ledger.pendingFunds.length > 0 || ledger.pendingRecover) {
    throw new Error('Finish the pending server wallet payment before rotating')
  }
  const summary = await refreshServerWallet(runtime)
  if (summary.money > 0 || summary.items > 0 || summary.tokens > 0) {
    throw new Error('Empty the server wallet before rotating its key')
  }
  const generation = ledger.generation + 1
  updateLedger(active, (current) => ({ ...current, generation }))
  console.info(`[server-wallet] rotated to generation ${generation}`)
  return generation
}

// ── fund ───────────────────────────────────────────────────────────────────

async function internalizeFund(
  active: ActiveWallet,
  wallet: WalletInterface,
  fund: PendingServerFund,
  atomicBeef?: number[],
): Promise<void> {
  const same = (p: PendingServerFund) => p.txid === fund.txid && p.outputIndex === fund.outputIndex
  if (!requireLedger(active).pendingFunds.some(same)) return
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
  updateLedger(active, (ledger) => ({
    ...ledger,
    pendingFunds: ledger.pendingFunds.filter((p) => !same(p)),
  }))
  console.info(`[server-wallet] fund ${fund.txid.slice(0, 12)} internalized ${fund.satoshis} sats`)
}

async function settlePendingFunds(active: ActiveWallet, wallet: WalletInterface): Promise<void> {
  for (const fund of requireLedger(active).pendingFunds) {
    await internalizeFund(active, wallet, fund)
  }
}

/**
 * BRC-29 payment to the server's identity key, then internalized into its
 * storage. The payment is recorded before internalizing; a miss retries on the
 * next refresh.
 */
export async function fundServerWallet(satoshis: number): Promise<{ txid: string }> {
  const runtime = requireWalletRuntime()
  const active = runtime.instance
  const ledger = requireLedger(active)
  const serverIdentity = serverWalletKey(active.rootKeyHex, ledger.generation).toPublicKey()
  const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
  const result = await sendBrc29ToIdentityKey({
    payeeIdentityKey: serverIdentity.toString(),
    satoshis,
    friendLabel: 'Server wallet',
    description: 'Fund server wallet',
  })
  const fund: PendingServerFund = {
    txid: result.txid.toLowerCase(),
    outputIndex: result.remittance.outputIndex ?? 0,
    satoshis,
    derivationPrefix: result.remittance.derivationPrefix,
    derivationSuffix: result.remittance.derivationSuffix,
  }
  updateLedger(active, (current) => ({ ...current, pendingFunds: [...current.pendingFunds, fund] }))
  console.info(`[server-wallet] funded ${satoshis} sats ${fund.txid.slice(0, 12)}.${fund.outputIndex}`)
  try {
    await exclusive(async () =>
      internalizeFund(active, await openServerWallet(active, ledger), fund, result.atomicBeef),
    )
  } catch (error) {
    console.warn(
      `[server-wallet] fund ${fund.txid.slice(0, 12)} internalize deferred — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  void refreshServerWallet(runtime).catch(() => {})
  return { txid: fund.txid }
}

// ── recover ────────────────────────────────────────────────────────────────

/** Fee the server's funding needs: every money input plus payment and change. */
function recoverFee(moneyOutputs: number): number {
  return Math.ceil(((10 + 148 * moneyOutputs + 34 * 2) * FEE_SAT_PER_KB) / 1000)
}

export function planServerWalletRecover(
  ledger: ServerWalletLedger,
  summary: Pick<ServerWalletSummary, 'money' | 'moneyOutputs'>,
): ServerWalletRecoverPlan {
  if (ledger.pendingRecover) return { path: 'finish', pending: ledger.pendingRecover }
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
): Promise<PendingServerRecover> {
  const [derivationPrefix, derivationSuffix] = await Promise.all([
    createNonce(server, 'self'),
    createNonce(server, 'self'),
  ])
  const { publicKey } = await server.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: active.identityKey,
  })
  const result = await server.createAction({
    description: 'Recover to HandCash',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex(),
        satoshis,
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
  if (!result.txid || !result.tx) throw new Error('Server wallet did not return the signed recovery')
  return {
    txid: result.txid,
    atomicBeefB64: Utils.toBase64(result.tx),
    satoshis,
    derivationPrefix,
    derivationSuffix,
  }
}

/**
 * Move the server wallet's money back into this wallet. Items and tokens stay
 * with the server. Stop the server first: a spend it makes concurrently can
 * take the same coins.
 */
export function recoverServerWallet(): Promise<{ txid: string; satoshis: number }> {
  const runtime = requireWalletRuntime()
  return exclusive(() => recoverExclusive(runtime))
}

async function recoverExclusive(
  runtime: WalletRuntime,
): Promise<{ txid: string; satoshis: number }> {
  const active = runtime.instance
  const ledger = requireLedger(active)
  const server = await openServerWallet(active, ledger)
  const plan = planServerWalletRecover(
    ledger,
    ledger.pendingRecover ? { money: 0, moneyOutputs: 0 } : await summarizeServerWallet(server),
  )
  const chart = createActor(serverWalletRecoverMachine).start()
  chart.send({ type: 'START', plan })
  try {
    if (plan.path === 'refuse') {
      throw new Error(
        plan.reason === 'uneconomical'
          ? 'Server wallet money does not cover the network fee'
          : 'The server wallet holds no money',
      )
    }
    let pending: PendingServerRecover
    if (plan.path === 'recover') {
      pending = await spendRecover(active, server, plan.satoshis)
      updateLedger(active, (current) => ({ ...current, pendingRecover: pending }))
      chart.send({ type: 'SPENT', txid: pending.txid })
    } else {
      pending = plan.pending
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
              senderIdentityKey: serverWalletKey(active.rootKeyHex, ledger.generation)
                .toPublicKey()
                .toString(),
            },
          },
        ],
        seekPermission: false,
      }),
    )
    updateLedger(active, (current) => ({ ...current, pendingRecover: null }))
    chart.send({ type: 'INTERNALIZED' })
    console.info(`[server-wallet] recovered ${pending.satoshis} sats txid=${pending.txid.slice(0, 12)}`)
    const { refreshSpendableBalance } = await import('./spendGuard')
    void refreshSpendableBalance().catch(() => {})
    const { scheduleHistoryBackupPush } = await import('./deviceSync')
    scheduleHistoryBackupPush('server-wallet-recover')
    void refreshServerWallet(runtime).catch(() => {})
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
