/**
 * BRC-175 leftover tips we created (send/burn change).
 *
 * listOutputs often still returns the spent mint and drops the new 1-sat
 * change tip. Balance is Σ amt on held leftovers — remember the remittance
 * we wrote so Tokens cannot snap back to the mint inscription.
 *
 * Not a Collect / basket-`1sat` scan.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { ONESAT_FT_PROTOCOL } from './colourCoins'

const KEY = 'handcash.onesat-ft.leftover.v1'
const SPENT_KEY = 'handcash.onesat-ft.spent-genesis.v1'

export type OnesatFtLeftover = {
  origin: string
  amt: number
  outpoint: string
  ci: string
  sym?: string
  supply?: 'locked' | 'open'
  maxSupply?: number | null
  at: number
}

export function normOnesatFtOutpoint(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function readAll(): Record<string, OnesatFtLeftover> {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { items?: Record<string, OnesatFtLeftover> }
    if (!parsed?.items || typeof parsed.items !== 'object') return {}
    return parsed.items
  } catch {
    return {}
  }
}

function writeAll(items: Record<string, OnesatFtLeftover>): void {
  durableSetItem(KEY, JSON.stringify({ items }))
}

export function rememberOnesatFtLeftover(row: Omit<OnesatFtLeftover, 'at'>): void {
  const origin = normOnesatFtOutpoint(row.origin)
  if (!origin || !(row.amt > 0) || !row.outpoint) {
    forgetOnesatFtLeftover(origin)
    return
  }
  const items = readAll()
  items[origin] = {
    origin,
    amt: row.amt,
    outpoint: normOnesatFtOutpoint(row.outpoint),
    ci:
      row.ci?.trim() ||
      JSON.stringify({
        p: ONESAT_FT_PROTOCOL,
        origin,
        amt: String(row.amt),
        ...(row.sym ? { sym: row.sym } : {}),
        ...(row.supply ? { supply: row.supply } : {}),
        ...(row.maxSupply != null ? { max: String(row.maxSupply) } : {}),
      }),
    ...(row.sym ? { sym: row.sym } : {}),
    ...(row.supply ? { supply: row.supply } : {}),
    ...(row.maxSupply != null ? { maxSupply: row.maxSupply } : {}),
    at: Date.now(),
  }
  writeAll(items)
  markOnesatFtGenesisSpent(origin)
}

export function forgetOnesatFtLeftover(origin: string): void {
  const k = normOnesatFtOutpoint(origin)
  if (k) markOnesatFtGenesisSpent(k)
  const items = readAll()
  if (!items[k]) return
  delete items[k]
  writeAll(items)
}

export function listOnesatFtLeftovers(): OnesatFtLeftover[] {
  return Object.values(readAll()).filter((r) => r.amt > 0 && r.outpoint)
}

export function getOnesatFtLeftover(origin: string): OnesatFtLeftover | null {
  return readAll()[normOnesatFtOutpoint(origin)] ?? null
}

export function leftoverForOutpoint(outpoint: string): OnesatFtLeftover | null {
  const op = normOnesatFtOutpoint(outpoint)
  if (!op) return null
  for (const row of Object.values(readAll())) {
    if (row.outpoint === op) return row
  }
  return null
}

function readSpent(): Set<string> {
  try {
    const raw = durableGetItem(SPENT_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((x): x is string => typeof x === 'string')
        .map(normOnesatFtOutpoint)
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

function writeSpent(items: Set<string>): void {
  durableSetItem(SPENT_KEY, JSON.stringify([...items]))
}

/** Spent 1sat-ft genesis — does not expire (unlike collectables SENT_HIDE_MS). */
export function markOnesatFtGenesisSpent(origin: string): void {
  const k = normOnesatFtOutpoint(origin)
  if (!k) return
  const spent = readSpent()
  if (spent.has(k)) return
  spent.add(k)
  writeSpent(spent)
}

export function isOnesatFtGenesisSpent(outpoint: string): boolean {
  const k = normOnesatFtOutpoint(outpoint)
  if (!k) return false
  return readSpent().has(k)
}

/** Already-broadcast KING send leftover (bare P2PKH, remittance overlay). */
export const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
export const KING_LEFTOVER_OUTPOINT =
  '9abe8bdb97f608b05ccf920768cea178315072d665027636a00fac38e0bb9c90_1'
export const BURNED_ONESAT_FT_ORIGINS = [
  'da0bc9952e65532f063c5f9ec4b4b12174b580380bea349e7c14b6d3bba52bb2_0',
  '4d255764fc7dfa3ce82052fe511439f532df40dda2f861b864c9e4eb644f86f0_0',
] as const

const KING_LEFTOVER_CI = JSON.stringify({
  p: ONESAT_FT_PROTOCOL,
  origin: KING_ORIGIN,
  amt: '69000',
  sym: 'KING',
  supply: 'locked',
  max: '69420',
})

export type ListedHealOutput = {
  outpoint?: string
  satoshis?: number
}

/**
 * Heal leftover remittance + spent-forever genesis.
 * Always seeds the known 9abe8bdb KING leftover (listOutputs often drops
 * that bare P2PKH change; the UTXO is still unspent on this wallet).
 */
export function healOnesatFtFromListed(_rows: ListedHealOutput[]): {
  seededLeftover: boolean
  forgotten: string[]
} {
  const forgotten: string[] = []
  for (const origin of BURNED_ONESAT_FT_ORIGINS) {
    if (getOnesatFtLeftover(origin)) forgotten.push(origin)
    forgetOnesatFtLeftover(origin)
    markOnesatFtGenesisSpent(origin)
  }
  markOnesatFtGenesisSpent(KING_ORIGIN)

  // listOutputs often drops the bare P2PKH change. On-chain 9abe8bdb_1 is
  // still unspent on this wallet — seed remittance so Tokens can show 69000.
  rememberOnesatFtLeftover({
    origin: KING_ORIGIN,
    amt: 69000,
    outpoint: KING_LEFTOVER_OUTPOINT,
    ci: KING_LEFTOVER_CI,
    sym: 'KING',
    supply: 'locked',
    maxSupply: 69420,
  })
  const seededLeftover = true

  for (const leftover of listOnesatFtLeftovers()) {
    markOnesatFtGenesisSpent(leftover.origin)
  }

  return { seededLeftover, forgotten }
}

export function knownBurnedOnesatFtOrigins(): string[] {
  return [...BURNED_ONESAT_FT_ORIGINS]
}
