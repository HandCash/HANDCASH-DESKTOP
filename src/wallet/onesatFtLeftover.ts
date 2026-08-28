/**
 * BRC-175 leftover tips we created (send/burn change).
 *
 * listOutputs often still returns the spent mint and drops the new 1-sat
 * change tip. Balance is Σ amt on held leftovers — remember the remittance
 * we wrote so Tokens cannot snap back to the mint inscription.
 *
 * Keyed by leftover outpoint. rememberOnesatFtLeftover is called from
 * sendColourCoins remittance. Heal only drops leftover rows whose outpoint
 * is sent. Never re-seed hardcoded leftover outpoints.
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

function readAll(): Record<string, OnesatFtLeftover> {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { items?: Record<string, OnesatFtLeftover> }
    if (!parsed?.items || typeof parsed.items !== 'object') return {}
    const out: Record<string, OnesatFtLeftover> = {}
    for (const [k, row] of Object.entries(parsed.items)) {
      if (!row || typeof row !== 'object') continue
      const origin = typeof row.origin === 'string' ? normOnesatFtOutpoint(row.origin) : ''
      const outpoint = normOnesatFtOutpoint(
        typeof row.outpoint === 'string' && row.outpoint ? row.outpoint : k,
      )
      if (!outpoint || typeof row.amt !== 'number') continue
      out[outpoint] = { ...row, origin, outpoint }
    }
    return out
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

function leftoverCap(row: Pick<OnesatFtLeftover, 'maxSupply'>): number | null {
  if (row.maxSupply != null && row.maxSupply > 0) return row.maxSupply
  return null
}

/** Inflated leftover: missing amt, or over the origin cap. */
export function onesatFtLeftoverAmtInflated(
  row: Pick<OnesatFtLeftover, 'amt' | 'maxSupply'>,
): boolean {
  if (!(row.amt > 0)) return true
  const cap = leftoverCap(row)
  return cap != null && row.amt > cap
}

function leftoverOutpointSent(outpoint: string): boolean {
  const op = normOnesatFtOutpoint(outpoint)
  if (!op) return true
  // Spent genesis is the mint UTXO. Leftover change is a different outpoint.
  return isItemSent(op)
}

/** Drop leftover rows whose outpoint is sent. */
function dropSentLeftovers(): string[] {
  const items = readAll()
  const forgotten: string[] = []
  for (const [op, row] of Object.entries(items)) {
    const leftoverOp = normOnesatFtOutpoint(row.outpoint || op)
    if (!leftoverOp || leftoverOutpointSent(leftoverOp) || onesatFtLeftoverAmtInflated(row)) {
      delete items[op]
      forgotten.push(leftoverOp || op)
    }
  }
  if (forgotten.length) writeAll(items)
  return forgotten
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
    if (origin) forgetOnesatFtLeftover(origin)
    if (outpoint) forgetOnesatFtLeftover(outpoint)
    return
  }
  if (leftoverOutpointSent(outpoint)) return
  const cap = row.maxSupply != null && row.maxSupply > 0 ? row.maxSupply : null
  if (cap != null && row.amt > cap) return
  const items = readAll()
  items[outpoint] = {
    origin,
    amt: row.amt,
    outpoint,
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
  dropSentLeftovers()
}

export function forgetOnesatFtLeftover(originOrOutpoint: string): void {
  const k = normOnesatFtOutpoint(originOrOutpoint)
  if (!k) return
  const items = readAll()
  let dirty = false
  let matchedOrigin = false
  for (const [op, row] of Object.entries(items)) {
    const origin = normOnesatFtOutpoint(row.origin)
    const outpoint = normOnesatFtOutpoint(row.outpoint) || op
    if (op === k || outpoint === k || origin === k) {
      if (origin === k) matchedOrigin = true
      delete items[op]
      dirty = true
    }
  }
  if (dirty) writeAll(items)
  // Full burn (caller passed origin) or unknown mint: mark genesis spent.
  // Do not mark leftover change outpoints as genesis.
  if (matchedOrigin || !dirty) markOnesatFtGenesisSpent(k)
}

export function listOnesatFtLeftovers(): OnesatFtLeftover[] {
  dropSentLeftovers()
  return Object.values(readAll()).filter(
    (r) => r.amt > 0 && r.outpoint && !onesatFtLeftoverAmtInflated(r) && !leftoverOutpointSent(r.outpoint),
  )
}

export function getOnesatFtLeftover(originOrOutpoint: string): OnesatFtLeftover | null {
  const k = normOnesatFtOutpoint(originOrOutpoint)
  if (!k) return null
  const items = readAll()
  const byOp = items[k]
  if (byOp && !onesatFtLeftoverAmtInflated(byOp) && !leftoverOutpointSent(byOp.outpoint)) {
    return byOp
  }
  for (const row of Object.values(items)) {
    if (normOnesatFtOutpoint(row.origin) !== k) continue
    if (onesatFtLeftoverAmtInflated(row) || leftoverOutpointSent(row.outpoint)) continue
    return row
  }
  return null
}

export function leftoverForOutpoint(outpoint: string): OnesatFtLeftover | null {
  const op = normOnesatFtOutpoint(outpoint)
  if (!op) return null
  const row = readAll()[op]
  if (!row) return null
  if (onesatFtLeftoverAmtInflated(row) || leftoverOutpointSent(op)) return null
  return row
}

/**
 * Overlay leftover outpoint once. Leftover is dropped bare-P2PKH change.
 * Do not skip leftover change just because a receive of the same origin is listed.
 * seenOutpoints must be . / _ normalized.
 */
export function shouldOverlayOnesatFtLeftover(
  leftover: Pick<OnesatFtLeftover, 'outpoint'> &
    Partial<Pick<OnesatFtLeftover, 'amt' | 'maxSupply'>>,
  seenOutpoints: Iterable<string>,
): boolean {
  const leftoverOp = normOnesatFtOutpoint(leftover.outpoint)
  if (!leftoverOp) return false
  const seen = new Set(
    [...seenOutpoints].map(normOnesatFtOutpoint).filter(Boolean),
  )
  if (seen.has(leftoverOp)) return false
  if (leftoverOutpointSent(leftoverOp)) return false
  if ('amt' in leftover && onesatFtLeftoverAmtInflated(leftover as OnesatFtLeftover)) {
    return false
  }
  return true
}

export type ListedHealOutput = {
  outpoint?: string
}

/**
 * Heal leftover remittance: drop leftover rows whose outpoint is sent.
 * Never re-seed hardcoded leftover outpoints.
 */
export function healOnesatFtFromListed(_rows?: ListedHealOutput[]): {
  seededLeftover: boolean
  forgotten: string[]
} {
  const forgotten = dropSentLeftovers()
  return { seededLeftover: false, forgotten }
}

export function spentOnesatFtGenesisOrigins(): string[] {
  return [...readSpent()]
}
