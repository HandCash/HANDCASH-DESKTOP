/**
 * Read and move the P2P-FT filing. Callers pass how to list one basket.
 * This module decides which baskets, and that an output moves once.
 */

import type { ActiveWallet } from '../session'
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

const moving = new Map<string, Promise<number>>()

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
 * List both filings and keep one row per outpoint.
 * Moves `bsv21` into `p2pft` first. A move that cannot run still returns both.
 */
export async function readTokenFiling<T>(
  wallet: ActiveWallet,
  read: (basket: string) => Promise<T[]>,
  outpoint: (row: T) => string | undefined,
): Promise<T[]> {
  const { walletRegionsIdle } = await import('../walletCoordinator')
  // A send waiting on this read must not start the one-time basket move.
  // Legacy `bsv21` rows are still listed below until the wallet is idle.
  if (walletRegionsIdle()) await moveLegacyTokenFiling(wallet)
  const current = await readOne(P2PFT_BASKET, read)
  const legacy = await readOne(LEGACY_TOKEN_BASKET, read)
  return mergeFilingRows([...current, ...legacy], outpoint)
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

/** Move every output filed under `bsv21` into `p2pft`. Once per wallet. */
export function moveLegacyTokenFiling(wallet: ActiveWallet): Promise<number> {
  const key = walletKey(wallet)
  const existing = moving.get(key)
  if (existing) return existing
  const run = moveLegacy(wallet).catch((err: unknown) => {
    moving.delete(key)
    console.warn(
      '[p2pft] filing move skipped',
      err instanceof Error ? err.message : String(err),
    )
    return 0
  })
  moving.set(key, run)
  return run
}

async function moveLegacy(wallet: ActiveWallet): Promise<number> {
  const storage = (wallet.wallet as { storage?: FilingStorage }).storage
  if (typeof storage?.runAsStorageProvider !== 'function') return 0
  const moved = await storage.runAsStorageProvider((sp) => moveOnProvider(sp, wallet.identityKey))
  if (moved > 0) console.info(`[p2pft] filing move done — ${moved} output(s)`)
  return moved
}

async function moveOnProvider(sp: FilingProvider, identityKey: string): Promise<number> {
  if (
    typeof sp.findUserByIdentityKey !== 'function' ||
    typeof sp.findOutputBaskets !== 'function' ||
    typeof sp.findOutputs !== 'function' ||
    typeof sp.updateOutput !== 'function'
  ) {
    return 0
  }
  const user = await sp.findUserByIdentityKey(identityKey)
  const userId = user?.userId
  if (typeof userId !== 'number') return 0
  const baskets = await sp.findOutputBaskets({ partial: { userId } })
  const legacy = baskets.find((b) => b.name?.trim().toLowerCase() === LEGACY_TOKEN_BASKET)
  const legacyId = legacy?.basketId
  if (typeof legacyId !== 'number') return 0
  let nextId = baskets.find((b) => b.name?.trim().toLowerCase() === P2PFT_BASKET)?.basketId
  if (typeof nextId !== 'number') {
    if (typeof sp.insertOutputBasket !== 'function') return 0
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
  if (typeof nextId !== 'number') return 0
  let moved = 0
  for (let page = 0; page < 100; page += 1) {
    const rows =
      (await sp.findOutputs({
        partial: { userId, basketId: legacyId },
        noScript: true,
        paged: { limit: 500, offset: 0 },
      })) ?? []
    if (rows.length === 0) return moved
    let progressed = 0
    for (const row of rows) {
      if (typeof row.outputId !== 'number') continue
      await sp.updateOutput(row.outputId, { basketId: nextId })
      progressed += 1
      moved += 1
    }
    if (progressed === 0 || rows.length < 500) return moved
  }
  return moved
}
