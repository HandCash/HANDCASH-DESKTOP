/**
 * Pin signed txs that reached Arcade on the initial postBeef round.
 *
 * Arcade often returns false doubleSpends / missing-inputs when a tx is still
 * local. Once Arcade was contacted, the send is not cancelable, not removable
 * from Activity, and inputs stay sealed until chain proof shows the spend failed.
 */
import { inputOutpointsFromAtomicBeef, inputOutpointsFromRawTx } from './txOutpoints'
import { spentStatusOfOutpoint, txExistsOnChain } from './legacyScan'
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'
import type { PostBeefServiceResult } from './postBeefResult'

const KEY = 'handcash.wallet.arcadeSubmit.v1'
const MAX = 500
/** Long enough for slow Teranode / mempool propagation. */
const TTL_MS = 14 * 24 * 60 * 60_000

type Entry = { at: number }

let cache: Map<string, Entry> | null = null

function load(): Map<string, Entry> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const now = Date.now()
    for (const [txid, value] of Object.entries(parsed)) {
      if (!/^[0-9a-f]{64}$/i.test(txid)) continue
      const at =
        value && typeof value === 'object' && typeof (value as Entry).at === 'number'
          ? (value as Entry).at
          : typeof value === 'number'
            ? value
            : 0
      if (now - at > TTL_MS) continue
      cache.set(txid.toLowerCase(), { at })
    }
  } catch {
    // ignore
  }
  return cache
}

function persist(): void {
  const map = load()
  const now = Date.now()
  const rows = [...map.entries()]
    .filter(([, e]) => now - e.at <= TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX)
  map.clear()
  const obj: Record<string, Entry> = {}
  for (const [txid, e] of rows) {
    map.set(txid, e)
    obj[txid] = e
  }
  durableSetItem(KEY, JSON.stringify(obj))
}

export function postBeefResultsHitArcade(
  results: PostBeefServiceResult[] | null | undefined,
): boolean {
  if (!Array.isArray(results)) return false
  return results.some((r) => String(r.name ?? '').toLowerCase().includes('arcade'))
}

export function rememberArcadeSubmitContact(txid: string): void {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return
  load().set(id, { at: Date.now() })
  persist()
}

export function txHadArcadeSubmitContact(txid: string): boolean {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return false
  const e = load().get(id)
  if (!e) return false
  if (Date.now() - e.at > TTL_MS) {
    load().delete(id)
    persist()
    return false
  }
  return true
}

export function forgetArcadeSubmitContact(txid: string): void {
  const id = txid.trim().toLowerCase()
  if (!load().delete(id)) return
  persist()
}

async function inputOutpointsForTx(
  txid: string,
  atomic?: number[],
): Promise<string[]> {
  if (atomic?.length) {
    const fromBeef = inputOutpointsFromAtomicBeef(atomic, txid)
    if (fromBeef.length > 0) return fromBeef
  }
  const { getActiveWallet } = await import('./session')
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return []
  try {
    const raw = await storage.runAsStorageProvider(
      async (sp: { getProvenOrRawTx?: (id: string) => Promise<{ rawTx?: number[] }> }) =>
        sp.getProvenOrRawTx?.(txid),
    )
    if (raw?.rawTx?.length) return inputOutpointsFromRawTx(raw.rawTx)
  } catch {
    /* optional */
  }
  return []
}

/**
 * True only when chain/indexer proof shows this signed tx cannot still land:
 * our tx is not on chain and at least one input is spent elsewhere.
 * Inconclusive indexer silence returns false (keep the row + sealed inputs).
 */
export async function signedTxSpendConflictIsProven(args: {
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return false

  const onChain = await txExistsOnChain(txid, args.chain).catch(() => null)
  if (onChain === true) return false

  const inputs = await inputOutpointsForTx(txid, args.atomic)
  if (inputs.length === 0) return false

  const statuses = await Promise.all(
    inputs.map((op) => spentStatusOfOutpoint(op, args.chain).catch(() => 'unknown' as const)),
  )
  if (statuses.some((s) => s === 'unknown')) return false
  return statuses.some((s) => s === 'spent')
}

/** Whether Activity / sealed inputs may treat this signed send as dead. */
export async function signedTxMayBeRemoved(args: {
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  if (!txHadArcadeSubmitContact(args.txid)) return true
  return signedTxSpendConflictIsProven(args)
}

export function __resetArcadeSubmitGuardForTests(): void {
  cache = new Map()
  durableSetItem(KEY, '{}')
}
