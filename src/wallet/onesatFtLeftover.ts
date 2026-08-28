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
import { isItemSent } from './sentItemGuard'

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

/** Already-broadcast KING send leftover (bare P2PKH, remittance overlay). */
export const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
export const KING_LEFTOVER_OUTPOINT =
  '9abe8bdb97f608b05ccf920768cea178315072d665027636a00fac38e0bb9c90_1'
/** Send 2a562450: 69 to vout 0, change 68931 on vout 1. 9abe8bdb_1 is spent. */
export const KING_SEND_TXID =
  '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19'
export const KING_CHANGE_OUTPOINT = `${KING_SEND_TXID}_1`
export const KING_RECEIVE_OUTPOINT = `${KING_SEND_TXID}_0`
export const KING_CHANGE_AMT = 68931
export const KING_RECEIVE_AMT = 69
export const KING_MAX_SUPPLY = 69420
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
  max: String(KING_MAX_SUPPLY),
})

const KING_CHANGE_CI = JSON.stringify({
  p: ONESAT_FT_PROTOCOL,
  origin: KING_ORIGIN,
  amt: String(KING_CHANGE_AMT),
  sym: 'KING',
  supply: 'locked',
  max: String(KING_MAX_SUPPLY),
})

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

function leftoverCap(row: Pick<OnesatFtLeftover, 'origin' | 'maxSupply'>): number | null {
  if (row.maxSupply != null && row.maxSupply > 0) return row.maxSupply
  if (normOnesatFtOutpoint(row.origin) === KING_ORIGIN) return KING_MAX_SUPPLY
  return null
}

/** Inflated leftover: over cap, or KING change whose remittance is not 68931. */
export function onesatFtLeftoverAmtInflated(
  row: Pick<OnesatFtLeftover, 'origin' | 'outpoint' | 'amt' | 'maxSupply'>,
): boolean {
  if (!(row.amt > 0)) return true
  const cap = leftoverCap(row)
  if (cap != null && row.amt > cap) return true
  const op = normOnesatFtOutpoint(row.outpoint)
  if (op === KING_CHANGE_OUTPOINT && row.amt !== KING_CHANGE_AMT) return true
  if (op === KING_RECEIVE_OUTPOINT) return true
  return false
}

function seedKingChangeLeftover(): void {
  rememberOnesatFtLeftover({
    origin: KING_ORIGIN,
    amt: KING_CHANGE_AMT,
    outpoint: KING_CHANGE_OUTPOINT,
    ci: KING_CHANGE_CI,
    sym: 'KING',
    supply: 'locked',
    maxSupply: KING_MAX_SUPPLY,
  })
}

function seedKingLegacyLeftover(): void {
  rememberOnesatFtLeftover({
    origin: KING_ORIGIN,
    amt: 69000,
    outpoint: KING_LEFTOVER_OUTPOINT,
    ci: KING_LEFTOVER_CI,
    sym: 'KING',
    supply: 'locked',
    maxSupply: KING_MAX_SUPPLY,
  })
}

function kingSendHappened(listed: Set<string>, existingOp: string): boolean {
  return (
    isItemSent(KING_LEFTOVER_OUTPOINT) ||
    isOnesatFtGenesisSpent(KING_LEFTOVER_OUTPOINT) ||
    listed.has(KING_RECEIVE_OUTPOINT) ||
    listed.has(KING_CHANGE_OUTPOINT) ||
    existingOp === KING_CHANGE_OUTPOINT
  )
}

/** Drop spent / receive / inflated leftover tips. Leftover is bare-P2PKH change only. */
function dropUnusableLeftovers(sendHappened: boolean): void {
  const items = readAll()
  let dirty = false
  for (const [origin, row] of Object.entries(items)) {
    const op = normOnesatFtOutpoint(row.outpoint)
    const spentTip =
      !op ||
      isItemSent(op) ||
      isOnesatFtGenesisSpent(op) ||
      op === KING_RECEIVE_OUTPOINT ||
      (op === KING_LEFTOVER_OUTPOINT && sendHappened)
    if (spentTip || onesatFtLeftoverAmtInflated(row)) {
      delete items[origin]
      dirty = true
    }
  }
  if (dirty) writeAll(items)
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

export function rememberOnesatFtLeftover(row: Omit<OnesatFtLeftover, 'at'>): void {
  const origin = normOnesatFtOutpoint(row.origin)
  const outpoint = normOnesatFtOutpoint(row.outpoint)
  if (!origin || !(row.amt > 0) || !outpoint) {
    forgetOnesatFtLeftover(origin)
    return
  }
  // Receive already in 1sat-ft is not leftover. Leftover is dropped
  // bare-P2PKH change only. One origin → one leftover tip.
  if (outpoint === KING_RECEIVE_OUTPOINT) {
    return
  }
  const cap = row.maxSupply ?? (origin === KING_ORIGIN ? KING_MAX_SUPPLY : null)
  if (cap != null && row.amt > cap) return
  let amt = row.amt
  if (outpoint === KING_CHANGE_OUTPOINT) amt = KING_CHANGE_AMT
  // After send 2a562450, spent 9abe8bdb_1 must not be re-seeded as 69000.
  if (outpoint === KING_LEFTOVER_OUTPOINT) {
    const existing = readAll()[origin]
    const existingOp = existing?.outpoint ? normOnesatFtOutpoint(existing.outpoint) : ''
    if (
      isItemSent(KING_LEFTOVER_OUTPOINT) ||
      isOnesatFtGenesisSpent(KING_LEFTOVER_OUTPOINT) ||
      existingOp === KING_CHANGE_OUTPOINT
    ) {
      return
    }
  }
  const items = readAll()
  items[origin] = {
    origin,
    amt,
    outpoint,
    ci:
      outpoint === KING_CHANGE_OUTPOINT
        ? KING_CHANGE_CI
        : row.ci?.trim() ||
          JSON.stringify({
            p: ONESAT_FT_PROTOCOL,
            origin,
            amt: String(amt),
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
  return Object.values(readAll()).filter(
    (r) => r.amt > 0 && r.outpoint && !onesatFtLeftoverAmtInflated(r),
  )
}

export function getOnesatFtLeftover(origin: string): OnesatFtLeftover | null {
  return readAll()[normOnesatFtOutpoint(origin)] ?? null
}

export function leftoverForOutpoint(outpoint: string): OnesatFtLeftover | null {
  const op = normOnesatFtOutpoint(outpoint)
  if (!op) return null
  for (const row of Object.values(readAll())) {
    if (normOnesatFtOutpoint(row.outpoint) === op) {
      return onesatFtLeftoverAmtInflated(row) ? null : row
    }
  }
  return null
}

/**
 * Overlay leftover outpoint once. Leftover is dropped bare-P2PKH change only.
 * Never overlay receive already in 1sat-ft, or spent 9abe8bdb 69000 next to
 * live 2a562450 tips. seenOutpoints must be . / _ normalized.
 */
export function shouldOverlayOnesatFtLeftover(
  leftover: Pick<OnesatFtLeftover, 'outpoint' | 'origin'> &
    Partial<Pick<OnesatFtLeftover, 'amt' | 'maxSupply'>>,
  seenOutpoints: Iterable<string>,
): boolean {
  const leftoverOp = normOnesatFtOutpoint(leftover.outpoint)
  if (!leftoverOp) return false
  const seen = new Set(
    [...seenOutpoints].map(normOnesatFtOutpoint).filter(Boolean),
  )
  if (seen.has(leftoverOp)) return false
  if (isItemSent(leftoverOp) || isOnesatFtGenesisSpent(leftoverOp)) return false
  if (leftoverOp === KING_RECEIVE_OUTPOINT) return false
  if ('amt' in leftover && onesatFtLeftoverAmtInflated(leftover as OnesatFtLeftover)) {
    return false
  }
  if (
    leftoverOp === KING_LEFTOVER_OUTPOINT &&
    (seen.has(KING_CHANGE_OUTPOINT) || seen.has(KING_RECEIVE_OUTPOINT))
  ) {
    return false
  }
  return true
}

export type ListedHealOutput = {
  outpoint?: string
}

/**
 * Heal leftover remittance + spent-forever genesis.
 *
 * 9abe8bdb_1 (69000) was the live leftover until send 2a562450 spent it.
 * After that send, leftover is change 2a562450_1 (68931). Never overwrite a
 * newer leftover, and never re-seed the spent 69000 tip.
 * Do not seed receive 69 as leftover if listOutputs already has it in 1sat-ft.
 */
export function healOnesatFtFromListed(rows: ListedHealOutput[]): {
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

  const listed = new Set(
    rows
      .map((r) => (r.outpoint ? normOnesatFtOutpoint(r.outpoint) : ''))
      .filter(Boolean),
  )
  const existing = getOnesatFtLeftover(KING_ORIGIN)
  const existingOp = existing?.outpoint ? normOnesatFtOutpoint(existing.outpoint) : ''
  const sendHappened = kingSendHappened(listed, existingOp)

  if (sendHappened) {
    markOnesatFtGenesisSpent(KING_LEFTOVER_OUTPOINT)
  }

  dropUnusableLeftovers(sendHappened)

  const after = getOnesatFtLeftover(KING_ORIGIN)
  const afterOp = after?.outpoint ? normOnesatFtOutpoint(after.outpoint) : ''
  const keepChange =
    afterOp === KING_CHANGE_OUTPOINT &&
    after?.amt === KING_CHANGE_AMT &&
    !onesatFtLeftoverAmtInflated(after)

  let seededLeftover = false
  if (keepChange) {
    // Post-send leftover (2a562450_1 / 68931). Do not wipe or re-seed 69000.
  } else if (sendHappened) {
    // Receive 69 listed (or 9abe8bdb spent) — leftover is dropped change only.
    seedKingChangeLeftover()
    seededLeftover = true
  } else {
    // listOutputs often drops the bare P2PKH change. 9abe8bdb_1 is still the
    // live leftover on wallets that have not sent since that tip.
    seedKingLegacyLeftover()
    seededLeftover = true
  }

  for (const leftover of listOnesatFtLeftovers()) {
    markOnesatFtGenesisSpent(leftover.origin)
  }

  return { seededLeftover, forgotten }
}

export function knownBurnedOnesatFtOrigins(): string[] {
  return [...BURNED_ONESAT_FT_ORIGINS]
}
