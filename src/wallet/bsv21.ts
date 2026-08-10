/**
 * BSV-21 fungible tokens (inscription MIME `application/bsv-20`).
 *
 * On-chain JSON: BRC-161 (draft). Basket / remittance: BRC-163 (draft),
 * basket `bsv21` — Collect only, never Pay / BSV balance.
 *
 * Trust model: holders verify *their* tips (local history / remittance).
 * Issuers are trusted for mint policy — global supply-cap proofs are not
 * required. Wire `"p":"bsv-20"` is historical; token id is deploy outpoint
 * (`txid_vout`).
 */

export const BSV21_BASKET = 'bsv21' as const
export const BSV21_MIME = 'application/bsv-20' as const
export const BSV21_PROTOCOL = 'bsv-20' as const

const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/i
const UINT64_RE = /^\d{1,20}$/

export type Bsv21Op =
  | 'deploy+mint'
  | 'deploy+auth'
  | 'mint'
  | 'auth'
  | 'transfer'
  | 'burn'

export type Bsv21Payload = {
  p: typeof BSV21_PROTOCOL
  op: Bsv21Op
  /** Present on transfer / mint / burn / auth (not deploy). */
  id?: string
  /** Present on deploy+mint / mint / transfer / burn. */
  amt?: string
  sym?: string
  icon?: string
  /** Decimal places from deploy (0–18). */
  dec?: number
}

/** One spendable BSV-21 UTXO tip held by this wallet. */
export type Bsv21Utxo = {
  outpoint: string
  tokenId: string
  amt: string
  op: Bsv21Op
  sym?: string
  icon?: string
  dec: number
  satoshis: number
}

/** Candidate tip ready to internalize into basket `bsv21`. */
export type Bsv21ImportItem = {
  outpoint: string
  txid: string
  vout: number
  tokenId: string
  amt: string
  op: Bsv21Op
  sym?: string
  icon?: string
  dec?: number
}

/** Aggregated balance for one token id (Collect list row). */
export type FungibleToken = {
  tokenId: string
  sym: string
  amt: string
  dec: number
  iconUrl?: string
  utxoCount: number
  /** Representative tip outpoint (first UTXO). */
  outpoint: string
}

export function normalizeTokenId(raw: string): string | null {
  const id = raw.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  return TOKEN_ID_RE.test(id) ? id : null
}

export function isBsv21Mime(mime: string | undefined | null): boolean {
  return (mime ?? '').trim().toLowerCase() === BSV21_MIME
}

function asOp(raw: unknown): Bsv21Op | null {
  if (typeof raw !== 'string') return null
  switch (raw.trim()) {
    case 'deploy+mint':
    case 'deploy+auth':
    case 'mint':
    case 'auth':
    case 'transfer':
    case 'burn':
      return raw.trim() as Bsv21Op
    default:
      return null
  }
}

function asAmt(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    const s = String(Math.trunc(raw))
    return UINT64_RE.test(s) ? s : null
  }
  if (typeof raw === 'string' && UINT64_RE.test(raw.trim())) return raw.trim()
  return null
}

function asDec(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 18) {
    return raw
  }
  if (typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim())) {
    const n = Number(raw.trim())
    if (n >= 0 && n <= 18) return n
  }
  return 0
}

/**
 * Parse a BSV-21 JSON body. Returns null when the document is not a usable
 * holding (auth-only ops without amt, wrong protocol, etc.).
 */
export function parseBsv21Json(raw: unknown): Bsv21Payload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.p !== BSV21_PROTOCOL) return null
  const op = asOp(o.op)
  if (!op) return null

  const id =
    typeof o.id === 'string' ? normalizeTokenId(o.id) : undefined
  const amt = asAmt(o.amt) ?? undefined
  const sym =
    typeof o.sym === 'string' && o.sym.trim() ? o.sym.trim().slice(0, 32) : undefined
  const icon =
    typeof o.icon === 'string' ? normalizeTokenId(o.icon) ?? o.icon.trim() : undefined
  const dec = asDec(o.dec)

  if (op === 'deploy+auth' || op === 'auth') {
    // Auth outputs are not balance-bearing holdings.
    return null
  }
  if (op === 'deploy+mint') {
    if (!amt) return null
    return { p: BSV21_PROTOCOL, op, amt, sym, icon, dec }
  }
  if (op === 'mint' || op === 'transfer' || op === 'burn') {
    if (!id || !amt) return null
    return { p: BSV21_PROTOCOL, op, id, amt, sym, icon, dec }
  }
  return null
}

/** Resolve token id for a tip that carries this payload. */
export function tokenIdForPayload(
  payload: Bsv21Payload,
  tipOutpoint: string,
): string | null {
  if (payload.id) return payload.id
  if (payload.op === 'deploy+mint') return normalizeTokenId(tipOutpoint)
  return null
}

export function isBalanceBearingOp(op: Bsv21Op): boolean {
  return op === 'deploy+mint' || op === 'mint' || op === 'transfer'
}

/** Format token amount with deploy decimals (amt is integer units). */
export function formatFungibleAmount(amt: string, dec: number): string {
  const safeDec = Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 0
  const digits = amt.replace(/\D/g, '') || '0'
  if (safeDec === 0) {
    return BigInt(digits).toLocaleString('en-US')
  }
  const padded = digits.padStart(safeDec + 1, '0')
  const whole = padded.slice(0, -safeDec) || '0'
  const frac = padded.slice(-safeDec).replace(/0+$/, '')
  const wholeFmt = BigInt(whole).toLocaleString('en-US')
  return frac ? `${wholeFmt}.${frac}` : wholeFmt
}

export function buildBsv21CustomInstructions(args: {
  tokenId: string
  amt: string
  op: Bsv21Op
  sym?: string
  icon?: string
  dec?: number
}): string {
  const body: Record<string, unknown> = {
    p: BSV21_PROTOCOL,
    op: args.op,
    id: args.tokenId,
    amt: args.amt,
  }
  if (args.sym) body.sym = args.sym
  if (args.icon) body.icon = args.icon
  if (args.dec != null && args.dec > 0) body.dec = String(args.dec)
  return JSON.stringify(body)
}

export function parseBsv21CustomInstructions(
  raw: string | undefined | null,
): Bsv21Payload | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    return parseBsv21Json(JSON.parse(raw))
  } catch {
    return null
  }
}

export function aggregateFungibles(utxos: Bsv21Utxo[]): FungibleToken[] {
  const byId = new Map<string, FungibleToken & { _sum: bigint }>()
  for (const u of utxos) {
    if (!isBalanceBearingOp(u.op)) continue
    const existing = byId.get(u.tokenId)
    const add = BigInt(u.amt.replace(/\D/g, '') || '0')
    if (!existing) {
      byId.set(u.tokenId, {
        tokenId: u.tokenId,
        sym: u.sym || shortTokenLabel(u.tokenId),
        amt: u.amt,
        dec: u.dec,
        iconUrl: undefined,
        utxoCount: 1,
        outpoint: u.outpoint,
        _sum: add,
      })
      continue
    }
    existing._sum += add
    existing.utxoCount += 1
    if (!existing.sym && u.sym) existing.sym = u.sym
    if (existing.dec === 0 && u.dec > 0) existing.dec = u.dec
  }
  return [...byId.values()]
    .map(({ _sum, ...row }) => ({ ...row, amt: _sum.toString() }))
    .sort((a, b) => a.sym.localeCompare(b.sym) || a.tokenId.localeCompare(b.tokenId))
}

export function shortTokenLabel(tokenId: string): string {
  const id = normalizeTokenId(tokenId) ?? tokenId
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

export function bsv21Tags(args: {
  tokenId: string
  amt: string
  sym?: string
}): string[] {
  return [
    'bsv21',
    `id:${args.tokenId}`,
    `amt:${args.amt}`,
    ...(args.sym ? [`sym:${args.sym.slice(0, 32)}`] : []),
  ]
}
