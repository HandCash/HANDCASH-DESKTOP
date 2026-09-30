/**
 * Spends this key made on another install, read from the history backup.
 *
 * Two installs of one identity are not a supported setup, but they happen, and
 * the second one is the only spender this wallet's ledger cannot see. Both
 * installs upload BRC-39 to the same object, so whenever the object's
 * `exportedAt` is not the one this install last wrote, someone else wrote it.
 * That snapshot is decrypted in the worker and read — never imported: Refresh
 * and signing do not pull BRC-39 into localState (`layers.ts`). Coins it shows
 * spent are hidden here under the other install's txid and remembered, so the
 * input certainty gate refuses them even before any explorer has seen that tx.
 *
 * Covers spends that were uploaded before this install signs. Two installs
 * signing within the same backup debounce are still a race only a node can
 * settle.
 */
import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  peerSpendCandidates,
  planPeerSpends,
  type PeerSpend,
} from './kernel/peerDeviceSpends'
import type { PeerSnapshot } from './peerSnapshot'
import { canonicalOutpoint, forgetClearedCoins } from './spendCertainty'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

/** A `HEAD` per this window at most on the signing path. */
const HEAD_EVERY_MS = 15_000
const WATCH_FIRST_MS = 5_000
const WATCH_EVERY_MS = 90_000
/** A snapshot that could not be read is tried again after this. */
const RETRY_FAILED_MS = 5 * 60_000
const SPEND_TTL_MS = 7 * 24 * 60 * 60_000
const OUTPUT_PAGE = 500
const OUTPUT_PAGES = 20

type Store = {
  seenExportedAt: number | null
  spends: Record<string, { spender: string; at: number }>
}

export type PeerRefresh =
  | { kind: 'off' | 'throttled' | 'absent' | 'own' | 'seen' }
  | { kind: 'read'; spent: number; withdrawn: number }
  | { kind: 'failed'; reason: string }

let storeKey: string | null = null
let store: Store | null = null
let lastHeadAt = 0
let failed: { exportedAt: number; at: number } | null = null
let inFlight: Promise<PeerRefresh> | null = null
const watched = new Set<string>()

function boundKey(): string | null {
  try {
    return accountLocalKey(storageRegistry.peerDeviceSpends.key)
  } catch {
    return null
  }
}

function load(): Store {
  const key = boundKey()
  if (store && key === storeKey) return store
  storeKey = key
  store = { seenExportedAt: null, spends: {} }
  if (!key) return store
  try {
    const parsed = JSON.parse(durableGetItem(key) ?? '{}') as Partial<Store>
    const now = Date.now()
    store.seenExportedAt =
      typeof parsed.seenExportedAt === 'number' ? parsed.seenExportedAt : null
    for (const [raw, entry] of Object.entries(parsed.spends ?? {})) {
      const outpoint = canonicalOutpoint(raw)
      if (!outpoint || !entry || typeof entry.spender !== 'string') continue
      if (now - Number(entry.at) > SPEND_TTL_MS) continue
      store.spends[outpoint] = { spender: entry.spender, at: Number(entry.at) }
    }
  } catch {
    /* corrupt blob → empty */
  }
  return store
}

function persist(next: Store): void {
  store = next
  if (storeKey) durableSetItem(storeKey, JSON.stringify(next))
}

/** The other install's txid that spent `outpoint`, when its snapshot said so. */
export function peerSpenderOf(outpoint: string): string | null {
  const key = canonicalOutpoint(outpoint)
  if (!key) return null
  const entry = load().spends[key]
  if (!entry || Date.now() - entry.at > SPEND_TTL_MS) return null
  return entry.spender
}

type LocalProvider = {
  makeAvailable?: () => Promise<{ storageIdentityKey?: string }>
  findOutputs: (args: unknown) => Promise<Array<{ txid?: unknown; vout?: unknown }>>
  findTransactions: (args: unknown) => Promise<unknown[]>
}

type LocalView = {
  storageIdentityKey: string | null
  candidates: PeerSpend[]
  knownHere: Set<string>
}

async function readLocalView(
  active: import('./session').ActiveWallet,
  snapshot: PeerSnapshot,
): Promise<LocalView> {
  return active.wallet.storage.runAsStorageProvider(async (activeSp) => {
    const sp = activeSp as unknown as LocalProvider
    const settings = await sp.makeAvailable?.().catch(() => null)
    const storageIdentityKey = settings?.storageIdentityKey ?? null
    const empty: LocalView = { storageIdentityKey, candidates: [], knownHere: new Set() }
    if (storageIdentityKey && storageIdentityKey === snapshot.storageIdentityKey) return empty

    const spendable = new Set<string>()
    for (let page = 0; page < OUTPUT_PAGES; page += 1) {
      const rows = await sp.findOutputs({
        partial: { spendable: true },
        noScript: true,
        paged: { limit: OUTPUT_PAGE, offset: page * OUTPUT_PAGE },
      })
      for (const row of rows ?? []) {
        const outpoint = canonicalOutpoint(`${String(row.txid ?? '')}.${String(row.vout ?? '')}`)
        if (outpoint) spendable.add(outpoint)
      }
      if (!rows || rows.length < OUTPUT_PAGE) break
    }
    const candidates = peerSpendCandidates(snapshot.txs, spendable)
    const knownHere = new Set<string>()
    for (const spender of new Set(candidates.map((c) => c.spender))) {
      const rows = await sp.findTransactions({
        partial: { txid: spender },
        noRawTx: true,
        paged: { limit: 1, offset: 0 },
      })
      if (rows?.length) knownHere.add(spender)
    }
    return { storageIdentityKey, candidates, knownHere }
  }) as Promise<LocalView>
}

async function applySnapshot(
  active: import('./session').ActiveWallet,
  snapshot: PeerSnapshot,
  exportedAt: number,
): Promise<PeerRefresh> {
  const current = load()
  const view = await readLocalView(active, snapshot)
  if (view.storageIdentityKey && view.storageIdentityKey === snapshot.storageIdentityKey) {
    persist({ ...current, seenExportedAt: exportedAt })
    return { kind: 'own' }
  }
  const recordedSpenders = new Set(Object.values(current.spends).map((e) => e.spender))
  const plan = planPeerSpends({
    txs: snapshot.txs,
    candidates: view.candidates,
    knownHere: view.knownHere,
    recordedSpenders,
  })

  const withdrawn = new Set(plan.withdrawn)
  const now = Date.now()
  const spends: Store['spends'] = {}
  for (const [outpoint, entry] of Object.entries(current.spends)) {
    if (!withdrawn.has(entry.spender)) spends[outpoint] = entry
  }
  for (const { outpoint, spender } of plan.spends) spends[outpoint] = { spender, at: now }
  persist({ seenExportedAt: exportedAt, spends })

  if (plan.spends.length > 0) {
    forgetClearedCoins(plan.spends.map((s) => s.outpoint))
    const bySpender = new Map<string, string[]>()
    for (const { outpoint, spender } of plan.spends) {
      bySpender.set(spender, [...(bySpender.get(spender) ?? []), outpoint])
    }
    const { hideSpentOutpoints } = await import('./staleOutputRelease')
    for (const [spender, outpoints] of bySpender) {
      await hideSpentOutpoints(outpoints, spender, active)
    }
    const { bumpBalanceAfterHeal } = await import('./session')
    bumpBalanceAfterHeal()
    console.warn(
      `[peer-device] ${plan.spends.length} coin(s) spent by another install (${[...bySpender.keys()]
        .map((t) => t.slice(0, 12))
        .join(',')}) — hidden here`,
    )
  }
  return { kind: 'read', spent: plan.spends.length, withdrawn: plan.withdrawn.length }
}

async function refreshOnce(): Promise<PeerRefresh> {
  const { pinnedActiveWallet } = await import('./pinnedWallet')
  const active = pinnedActiveWallet()
  if (!active?.rootKeyHex) return { kind: 'off' }
  const { resolveHistoryBackupBaseUrl, getHistoryBackupPrefs } = await import('./historyBackupPrefs')
  if (!resolveHistoryBackupBaseUrl()) return { kind: 'off' }

  const { fetchRemoteBrc39Meta, fetchRemoteBrc39Bytes } = await import('./historyBackup')
  lastHeadAt = Date.now()
  const meta = await fetchRemoteBrc39Meta()
  if (!meta?.exists || meta.exportedAt == null) return { kind: 'absent' }
  if (meta.exportedAt === getHistoryBackupPrefs().lastUploadedAt) return { kind: 'own' }
  if (meta.exportedAt === load().seenExportedAt) return { kind: 'seen' }
  if (failed?.exportedAt === meta.exportedAt && Date.now() - failed.at < RETRY_FAILED_MS) {
    return { kind: 'seen' }
  }

  const started = Date.now()
  try {
    const blob = await fetchRemoteBrc39Bytes()
    if (!blob) return { kind: 'absent' }
    const exportedAt = blob.exportedAt ?? meta.exportedAt
    const { historyCryptoSecret } = await import('./historyCryptoSecret')
    const { readBrc39Snapshot } = await import('./brc39Encrypt')
    const snapshot = await readBrc39Snapshot(blob.bytes, historyCryptoSecret(active.rootKeyHex))
    const result = await applySnapshot(active, snapshot, exportedAt)
    failed = null
    console.info(
      `[peer-device] snapshot ${exportedAt} ${result.kind}${
        result.kind === 'read' ? ` spent=${result.spent} withdrawn=${result.withdrawn}` : ''
      } txs=${snapshot.txs.length} done ${Date.now() - started}ms`,
    )
    return result
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    failed = { exportedAt: meta.exportedAt, at: Date.now() }
    console.warn(`[peer-device] snapshot ${meta.exportedAt} unread — ${reason}`)
    return { kind: 'failed', reason }
  }
}

/**
 * Learn what another install spent since this one last looked. Single-flight;
 * without `force`, at most one `HEAD` per {@link HEAD_EVERY_MS}.
 */
export function refreshPeerDeviceSpends(opts?: { force?: boolean }): Promise<PeerRefresh> {
  if (inFlight) return inFlight
  if (!opts?.force && Date.now() - lastHeadAt < HEAD_EVERY_MS) {
    return Promise.resolve({ kind: 'throttled' })
  }
  inFlight = refreshOnce()
    .catch((err): PeerRefresh => ({
      kind: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Look on unlock, then periodically, so the signing path rarely has to decrypt. */
export function schedulePeerDeviceWatch(runtime: WalletRuntime): void {
  if (watched.has(runtime.runtimeId)) return
  watched.add(runtime.runtimeId)
  const tick = async () => {
    if (!runtimeIsCurrent(runtime)) return
    const { isRecomposeInFlight } = await import('./recompose')
    if (isRecomposeInFlight()) return
    await refreshPeerDeviceSpends({ force: true })
  }
  const first = setTimeout(() => void tick(), WATCH_FIRST_MS)
  const every = setInterval(() => void tick(), WATCH_EVERY_MS)
  runtime.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(first)
      clearInterval(every)
      watched.delete(runtime.runtimeId)
    },
    { once: true },
  )
}

export function resetPeerDeviceSpendsForTests(): void {
  storeKey = null
  store = null
  lastHeadAt = 0
  failed = null
  inFlight = null
  watched.clear()
}
