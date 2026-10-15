/**
 * Read and move the P2P-FT filing. Callers pass how to list one basket.
 * This module decides which baskets, and that an output moves once.
 */

import { storageRegistry } from '../../storage/registry'
import type { ActiveWallet } from '../session'
import { durableGetItem, durableSetItem } from '../durableStorage'
import {
  LEGACY_TOKEN_BASKET,
  P2PFT_BASKET,
  TOKEN_FILING_BASKETS,
  mergeFilingRows,
} from './filing'

type FilingProvider = {
  findUserByIdentityKey?: (identityKey: string) => Promise<{ userId?: number } | undefined>
  findOutputBaskets?: (args: {
    partial: { userId: number; name?: string }
  }) => Promise<Array<{ basketId?: number; name?: string }>>
  findOutputs?: (args: {
    partial: { userId: number; basketId: number }
    noScript?: boolean
    paged?: { limit: number; offset: number }
  }) => Promise<Array<{ outputId?: number }> | undefined>
  updateOutput?: (id: number, update: { basketId: number }) => Promise<unknown>
  insertOutputBasket?: (row: {
    basketId: number
    userId: number
    name: string
    numberOfDesiredUTXOs: number
    minimumDesiredUTXOValue: number
    isDeleted: boolean
    created_at: Date
    updated_at: Date
  }) => Promise<number>
}

type FilingStorage = {
  runAsStorageProvider?: <T>(fn: (sp: FilingProvider) => Promise<T>) => Promise<T>
}

const MOVED_KEY = storageRegistry.legacyTokenFilingMoved.key

export type LegacyMove = 'done' | 'pending' | 'skipped'

const moving = new Map<string, Promise<LegacyMove>>()
const moved = new Set<string>()
let movedLoaded = false

function loadMoved(): Set<string> {
  if (movedLoaded) return moved
  movedLoaded = true
  try {
    const raw = durableGetItem(MOVED_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) {
      for (const key of parsed) if (typeof key === 'string' && key) moved.add(key)
    }
  } catch {
    moved.clear()
  }
  return moved
}

function rememberMoved(key: string): void {
  const keys = loadMoved()
  if (keys.has(key)) return
  keys.add(key)
  durableSetItem(MOVED_KEY, JSON.stringify([...keys]))
}

function walletKey(wallet: Pick<ActiveWallet, 'chain' | 'accountIndex' | 'identityKey'>): string {
  return `${wallet.chain}:${wallet.accountIndex}:${wallet.identityKey}`
}

function absentBasket(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/listed \d+ of \d+/.test(msg)) return false
  return /unknown basket|no basket|not found|does not exist/i.test(msg)
}

async function readOne<T>(basket: string, read: (basket: string) => Promise<T[]>): Promise<T[]> {
  try {
    return await read(basket)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/listed \d+ of \d+/.test(msg)) throw err
    if (basket === LEGACY_TOKEN_BASKET || absentBasket(err)) return []
    throw err
  }
}

/**
 * List the live filing, `p2pft`.
 *
 * `bsv21` is not a listOutputs target. Rows still filed there move into
 * `p2pft` by indexed id, and only when a send is not waiting on the storage
 * lock. Until that move finishes, a send uses the tips it already has.
 */
export async function readTokenFiling<T>(
  wallet: ActiveWallet,
  read: (basket: string) => Promise<T[]>,
  outpoint: (row: T) => string | undefined,
): Promise<T[]> {
  const { spendNeedsStorage } = await import('../walletCoordinator')
  if (!spendNeedsStorage()) await moveLegacyTokenFiling(wallet)
  const current = await readOne(P2PFT_BASKET, read)
  return mergeFilingRows(current, outpoint)
}

/** Drop a token output from whichever filing still holds it. */
export async function relinquishTokenFiling(
  wallet: { relinquishOutput(args: { basket: string; output: string }): Promise<unknown> },
  output: string,
): Promise<void> {
  for (const basket of TOKEN_FILING_BASKETS) {
    try {
      await wallet.relinquishOutput({ basket, output })
    } catch {
      /* The output is in the other filing, or the spend already dropped it. */
    }
  }
}

/** Move every output filed under `bsv21` into `p2pft`. Retries until done. */
export function moveLegacyTokenFiling(wallet: ActiveWallet): Promise<LegacyMove> {
  const key = walletKey(wallet)
  if (loadMoved().has(key)) return Promise.resolve('done')
  const existing = moving.get(key)
  if (existing) return existing
  const run = moveLegacy(wallet)
    .then((result) => {
      moving.delete(key)
      if (result === 'done') rememberMoved(key)
      return result
    })
    .catch((err: unknown) => {
      moving.delete(key)
      console.warn(
        '[p2pft] filing move skipped',
        err instanceof Error ? err.message : String(err),
      )
      return 'skipped' as const
    })
  moving.set(key, run)
  return run
}

async function moveLegacy(wallet: ActiveWallet): Promise<LegacyMove> {
  const storage = (wallet.wallet as { storage?: FilingStorage }).storage
  if (typeof storage?.runAsStorageProvider !== 'function') return 'skipped'
  const { spendNeedsStorage } = await import('../walletCoordinator')
  if (spendNeedsStorage()) return 'pending'
  const result = await storage.runAsStorageProvider((sp) =>
    moveOnProvider(sp, wallet.identityKey),
  )
  if (result.moved > 0) {
    console.info(
      `[p2pft] filing move ${result.status} — ${result.moved} output(s) into p2pft`,
    )
  }
  return result.status
}

async function moveOnProvider(
  sp: FilingProvider,
  identityKey: string,
): Promise<{ status: LegacyMove; moved: number }> {
  if (
    typeof sp.findUserByIdentityKey !== 'function' ||
    typeof sp.findOutputBaskets !== 'function' ||
    typeof sp.findOutputs !== 'function' ||
    typeof sp.updateOutput !== 'function'
  ) {
    return { status: 'skipped', moved: 0 }
  }
  const { spendNeedsStorage } = await import('../walletCoordinator')
  const user = await sp.findUserByIdentityKey(identityKey)
  const userId = user?.userId
  if (typeof userId !== 'number') return { status: 'skipped', moved: 0 }
  const baskets = await sp.findOutputBaskets({ partial: { userId } })
  const legacy = baskets.find((b) => b.name?.trim().toLowerCase() === LEGACY_TOKEN_BASKET)
  const legacyId = legacy?.basketId
  if (typeof legacyId !== 'number') return { status: 'done', moved: 0 }
  let nextId = baskets.find((b) => b.name?.trim().toLowerCase() === P2PFT_BASKET)?.basketId
  if (typeof nextId !== 'number') {
    if (typeof sp.insertOutputBasket !== 'function') return { status: 'skipped', moved: 0 }
    const now = new Date()
    nextId = await sp.insertOutputBasket({
      basketId: 0,
      userId,
      name: P2PFT_BASKET,
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 0,
      isDeleted: false,
      created_at: now,
      updated_at: now,
    })
  }
  if (typeof nextId !== 'number') return { status: 'skipped', moved: 0 }
  let moved = 0
  for (let page = 0; page < 100; page += 1) {
    if (spendNeedsStorage()) return { status: 'pending', moved }
    const rows =
      (await sp.findOutputs({
        partial: { userId, basketId: legacyId },
        noScript: true,
        paged: { limit: 500, offset: 0 },
      })) ?? []
    if (rows.length === 0) return { status: 'done', moved }
    let progressed = 0
    for (const row of rows) {
      if (spendNeedsStorage()) return { status: 'pending', moved }
      if (typeof row.outputId !== 'number') continue
      await sp.updateOutput(row.outputId, { basketId: nextId })
      progressed += 1
      moved += 1
    }
    if (progressed === 0 || rows.length < 500) return { status: 'done', moved }
  }
  return { status: 'pending', moved }
}
