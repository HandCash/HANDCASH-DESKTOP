/**
 * 1Sat fungibles (BRC-175) — 1-sat tips that share one origin.
 *
 * Product branding: **1Sat**. Storage basket `1sat-ft`.
 * Each tip carries face value `amt` (missing ⇒ 1). Balance = Σ amt.
 * Transfers spend tips and create new 1-sat tips (payee + change) with
 * conserved amt; BRC-150 when lineage exists. No indexer for custody.
 *
 * Spec: BRCs/tokens/0175.md · docs/bsva/brcs/tokens/onesat-fungibles-proposal.md
 */

import { verifyProvenanceV2, type ProvenanceV2 } from './oneSatProvenance'
import { hasOrdEnvelope, parseOrdEnvelope } from './ordinalOwnership'

/** Normative BRC-175 storage basket. */
export const ONESAT_FT_BASKET = '1sat-ft' as const
export const ONESAT_FT_PROTOCOL = '1sat-ft' as const
export const ONESAT_FT_TAG = '1sat-ft' as const

/** @deprecated Use {@link ONESAT_FT_BASKET} */
export const COLOUR_BASKET = ONESAT_FT_BASKET
/** @deprecated Use {@link ONESAT_FT_PROTOCOL} */
export const COLOUR_PROTOCOL = ONESAT_FT_PROTOCOL
/** @deprecated Use {@link ONESAT_FT_TAG} */
export const COLOUR_TAG = ONESAT_FT_TAG

const ORIGIN_RE = /^[0-9a-f]{64}_\d+$/i
const decoder = new TextDecoder()

function toUnderscore(outpoint: string): string {
  const s = outpoint.trim()
  return s.includes('.') ? s.replace(/\.(\d+)$/, '_$1') : s
}

export function isColourOrigin(id: string): boolean {
  return ORIGIN_RE.test(toUnderscore(id.trim()))
}

export function normalizeColourOrigin(raw: string): string {
  const n = toUnderscore(raw.trim()).toLowerCase()
  if (!isColourOrigin(n)) throw new Error('Invalid 1Sat fungible origin')
  return n
}

export type ColourSupply = 'locked' | 'open'

export type ColourToken = {
  origin: string
  sym: string
  /** Bound tip UTXO count. */
  tipCount: number
  /** Σ face-value `amt` on bound tips. */
  balance: number
  supply: ColourSupply
  maxSupply: number | null
  provenanceOk: boolean
  outpoint: string
  name?: string
  iconUrl?: string
}

export type ColourTip = {
  outpoint: string
  origin: string
  satoshis: number
  /** Face-value units (missing remittance ⇒ 1). */
  amt: number
  lockingScript?: string
  name?: string
  provenance?: ProvenanceV2
  proven: boolean
  customInstructions?: string
}

/** Parse tip face value; missing / invalid ⇒ 1 (legacy tip-count rows). */
export function parseColourTipAmt(args: {
  customInstructions?: unknown
  lockingScriptHex?: string
}): number {
  const fromRecord = (o: Record<string, unknown> | null): number | null => {
    if (!o) return null
    const raw = o.amt ?? o.amount
    if (raw == null || raw === '') return null
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d]/g, ''))
    if (!Number.isSafeInteger(n) || n <= 0) return null
    return n
  }

  const ci = asRecord(args.customInstructions)
  if (ci) {
    const nested =
      ci.colour && typeof ci.colour === 'object' && !Array.isArray(ci.colour)
        ? (ci.colour as Record<string, unknown>)
        : ci
    const fromCi = fromRecord(nested)
    if (fromCi != null) return fromCi
  }

  if (args.lockingScriptHex) {
    const env = parseOrdEnvelope(args.lockingScriptHex)
    if (env?.body?.length) {
      try {
        const json = JSON.parse(decoder.decode(env.body)) as unknown
        const fromOrd = fromRecord(asRecord(json))
        if (fromOrd != null) return fromOrd
      } catch {
        // default below
      }
    }
  }

  return 1
}

export function tipFaceAmt(tip: Pick<ColourTip, 'amt'>): number {
  return Number.isSafeInteger(tip.amt) && tip.amt > 0 ? tip.amt : 1
}

/** Durable policy from origin inscription (BRC-175). */
export type ColourOriginMeta = {
  origin: string
  supply: ColourSupply
  maxSupply: number | null
  sym?: string
  name?: string
  /** Schema version on origin body when known. */
  schemaV?: number
}

export function isOnesatFtBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  return basket.trim().toLowerCase() === ONESAT_FT_BASKET
}

/** @deprecated Use {@link isOnesatFtBasket} */
export function isColourBasket(basket: unknown): boolean {
  return isOnesatFtBasket(basket)
}

export function colourTags(origin: string, extra: string[] = []): string[] {
  const o = normalizeColourOrigin(origin)
  const dotted = o.replace(/_(\d+)$/, '.$1')
  return [ONESAT_FT_TAG, 'ordinal', `origin:${dotted}`, ...extra]
}

export function originFromColourTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null
  for (const t of tags) {
    if (typeof t !== 'string') continue
    const m = /^origin:(.+)$/i.exec(t.trim())
    if (!m?.[1]) continue
    try {
      return normalizeColourOrigin(m[1])
    } catch {
      // keep scanning
    }
  }
  return null
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function parseSupplyFields(o: Record<string, unknown>): {
  supply: ColourSupply
  maxSupply: number | null
} {
  const supplyRaw = String(o.supply ?? o.cap ?? '').toLowerCase()
  const locked =
    supplyRaw === 'locked' || supplyRaw === 'closed' || o.locked === true
  let maxSupply: number | null = null
  const maxRaw = o.max ?? o.maxSupply ?? o.supplyCap
  if (maxRaw != null && maxRaw !== '') {
    const n = typeof maxRaw === 'number' ? maxRaw : Number(String(maxRaw))
    if (Number.isSafeInteger(n) && n > 0) maxSupply = n
  }
  return {
    supply: locked ? 'locked' : 'open',
    maxSupply: locked ? maxSupply : null,
  }
}

/**
 * Parse BRC-175 origin policy from an ord envelope body (preferred) or CI.
 */
export function parseOnesatFtOriginPolicy(
  origin: string,
  args: { lockingScriptHex?: string; customInstructions?: unknown },
): ColourOriginMeta {
  const base: ColourOriginMeta = {
    origin: normalizeColourOrigin(origin),
    supply: 'open',
    maxSupply: null,
  }

  const fromBody = (o: Record<string, unknown>): ColourOriginMeta | null => {
    const p = String(o.p ?? '').toLowerCase()
    if (p && p !== ONESAT_FT_PROTOCOL) return null
    const { supply, maxSupply } = parseSupplyFields(o)
    const schemaV =
      typeof o.v === 'number' && Number.isSafeInteger(o.v) ? o.v : undefined
    const sym =
      typeof o.sym === 'string' && o.sym.trim()
        ? o.sym.trim().slice(0, 32)
        : undefined
    const name =
      typeof o.name === 'string' && o.name.trim()
        ? o.name.trim().slice(0, 80)
        : undefined
    return {
      origin: base.origin,
      supply,
      maxSupply: supply === 'locked' ? maxSupply : null,
      ...(schemaV != null ? { schemaV } : {}),
      ...(sym ? { sym } : {}),
      ...(name ? { name } : {}),
    }
  }

  if (args.lockingScriptHex) {
    const env = parseOrdEnvelope(args.lockingScriptHex)
    if (env?.body?.length) {
      try {
        const json = JSON.parse(decoder.decode(env.body)) as unknown
        const o = asRecord(json)
        if (o) {
          const parsed = fromBody(o)
          if (parsed) return parsed
        }
      } catch {
        // fall through to CI
      }
    }
  }

  const ci = asRecord(args.customInstructions)
  if (ci) {
    const nested =
      ci.colour && typeof ci.colour === 'object' && !Array.isArray(ci.colour)
        ? (ci.colour as Record<string, unknown>)
        : ci
    const parsed = fromBody(nested)
    if (parsed) return parsed
  }

  return base
}

/** @deprecated Prefer {@link parseOnesatFtOriginPolicy} */
export function parseColourOriginMeta(
  origin: string,
  customInstructions: unknown,
): ColourOriginMeta {
  return parseOnesatFtOriginPolicy(origin, { customInstructions })
}

export function buildColourCustomInstructions(args: {
  origin: string
  name?: string
  sym?: string
  /** Face-value units on this tip. */
  amt?: number
  supply?: ColourSupply
  maxSupply?: number | null
  provenance?: ProvenanceV2 | null
  mintBatchVout?: number
  /** @deprecated Interop ignores extend for binding. */
  mintExtend?: boolean
  parent?: string
}): string {
  const origin = normalizeColourOrigin(args.origin)
  const body: Record<string, unknown> = {
    p: ONESAT_FT_PROTOCOL,
    origin,
  }
  if (args.name) body.name = args.name
  if (args.sym) body.sym = args.sym
  if (args.amt != null && Number.isSafeInteger(args.amt) && args.amt > 0) {
    body.amt = String(args.amt)
  }
  // Locked supply is optional — only echo when the origin defines it.
  if (args.supply === 'locked') {
    body.supply = 'locked'
    if (args.maxSupply != null) body.max = String(args.maxSupply)
  } else if (args.supply === 'open') {
    body.supply = 'open'
  }
  if (args.mintBatchVout != null && Number.isSafeInteger(args.mintBatchVout)) {
    body.mint = { batch: true, vout: args.mintBatchVout }
  } else if (args.mintExtend) {
    body.mint = { extend: true }
  }
  if (args.parent) {
    try {
      body.parent = toUnderscore(args.parent).toLowerCase()
    } catch {
      // omit
    }
  }
  if (args.provenance) body.provenance = args.provenance
  return JSON.stringify(body)
}

/**
 * Build genesis origin / mint-tip ord JSON (BRC-175).
 * Locked supply (`supply` + `max`) is optional. Face value `amt` is required
 * (defaults to `maxSupply` when locking a single-tip mint).
 */
export function buildOnesatFtOriginInscriptionJson(args: {
  sym: string
  name?: string
  /** Face value of this tip. Required unless `maxSupply` is set (then defaults to max). */
  amt?: number
  /** Optional: lock total units at genesis. */
  supply?: ColourSupply
  maxSupply?: number | null
}): Record<string, string | number> {
  const sym = args.sym.trim().slice(0, 32)
  if (!sym) throw new Error('Symbol required')

  const locked = args.supply === 'locked'
  const max =
    args.maxSupply != null &&
    Number.isSafeInteger(args.maxSupply) &&
    args.maxSupply > 0
      ? args.maxSupply
      : null
  if (locked && max == null) {
    throw new Error('Locked supply requires maxSupply')
  }

  const amt =
    args.amt != null && Number.isSafeInteger(args.amt) && args.amt > 0
      ? args.amt
      : max
  if (amt == null) {
    throw new Error('amt is required (or maxSupply for a single-tip locked mint)')
  }

  const json: Record<string, string | number> = {
    p: ONESAT_FT_PROTOCOL,
    v: 1,
    amt: String(amt),
    sym,
  }
  if (locked && max != null) {
    json.supply = 'locked'
    json.max = String(max)
  } else if (args.supply === 'open') {
    json.supply = 'open'
  }
  if (args.name?.trim()) json.name = args.name.trim().slice(0, 80)
  return json
}

export function parseColourMintAttestation(customInstructions: unknown): {
  mintBatchVout: number | null
  mintExtend: boolean
  parent: string | null
} {
  const o = asRecord(customInstructions)
  if (!o) return { mintBatchVout: null, mintExtend: false, parent: null }
  const mint =
    o.mint && typeof o.mint === 'object' && !Array.isArray(o.mint)
      ? (o.mint as Record<string, unknown>)
      : null
  let mintBatchVout: number | null = null
  let mintExtend = false
  if (mint?.batch === true && typeof mint.vout === 'number' && mint.vout >= 0) {
    mintBatchVout = mint.vout
  }
  if (mint?.extend === true) mintExtend = true
  let parent: string | null = null
  if (typeof o.parent === 'string' && o.parent.trim()) {
    try {
      parent = toUnderscore(o.parent).toLowerCase()
    } catch {
      parent = null
    }
  }
  return { mintBatchVout, mintExtend, parent }
}

export type BindCheck = { ok: boolean; reason: string | null; via?: string }

/**
 * BRC-175 binding: genesis | BRC-150 | mint-batch | parent hop.
 * `mint.extend` does not bind. Locked `max` is total units (not a vout ceiling).
 */
export function verifyColourTipProvenance(args: {
  tipOutpoint: string
  claimedOrigin: string
  provenance: ProvenanceV2 | null | undefined
  lockingScriptHex?: string
  customInstructions?: unknown
  /** Origin policy when known (from origin tip). */
  originMeta?: ColourOriginMeta | null
  /** For inductive parent: whether parent tip is already bound. */
  parentBound?: boolean
}): BindCheck {
  const origin = normalizeColourOrigin(args.claimedOrigin)
  const tip = toUnderscore(args.tipOutpoint).toLowerCase()
  const attest = parseColourMintAttestation(args.customInstructions)
  const meta = args.originMeta ?? null
  const locked = meta?.supply === 'locked'

  if (tip === origin) {
    if (args.lockingScriptHex && !hasOrdEnvelope(args.lockingScriptHex)) {
      return { ok: false, reason: 'Origin tip has no ord envelope' }
    }
    const policy = parseOnesatFtOriginPolicy(origin, {
      lockingScriptHex: args.lockingScriptHex,
      customInstructions: args.customInstructions,
    })
    if (policy.supply === 'locked' && (policy.maxSupply == null || policy.maxSupply <= 0)) {
      return { ok: false, reason: 'Locked origin missing max' }
    }
    return { ok: true, reason: null, via: 'genesis' }
  }

  if (args.provenance) {
    const result = verifyProvenanceV2(args.provenance, tip)
    if (result.proven) {
      const provenOrigin = toUnderscore(args.provenance.origin).toLowerCase()
      if (provenOrigin === origin) {
        return { ok: true, reason: null, via: 'brc-150' }
      }
      return { ok: false, reason: 'Provenance origin mismatch' }
    }
  }

  const tipTx = tip.split('_')[0] ?? ''
  const originTx = origin.split('_')[0] ?? ''
  const tipVout = Number(tip.split('_')[1] ?? NaN)
  if (
    tipTx &&
    tipTx === originTx &&
    Number.isSafeInteger(tipVout) &&
    tipVout >= 0 &&
    attest.mintBatchVout === tipVout
  ) {
    if (args.lockingScriptHex && !hasOrdEnvelope(args.lockingScriptHex)) {
      return { ok: false, reason: 'Mint tip has no ord envelope' }
    }
    return { ok: true, reason: null, via: 'mint-batch' }
  }

  // Extend does not bind.
  if (attest.mintExtend) {
    return { ok: false, reason: 'Open mint extend is not interop v1' }
  }

  if (attest.parent && args.parentBound === true) {
    if (args.lockingScriptHex && !hasOrdEnvelope(args.lockingScriptHex)) {
      // Transferred tips may be bare P2PKH — allow remittance-only hop.
    }
    return { ok: true, reason: null, via: 'parent' }
  }

  if (attest.parent && args.parentBound == null) {
    if (locked) {
      return { ok: false, reason: 'Locked tip needs batch, provenance, or proven parent' }
    }
    return { ok: true, reason: null, via: 'parent-unverified' }
  }

  if (!args.provenance) {
    return { ok: false, reason: 'Missing provenance' }
  }
  return { ok: false, reason: 'Provenance failed' }
}

export function evaluateColourSupply(args: {
  meta: ColourOriginMeta
  /** Σ face-value units held locally. */
  heldUnits: number
}): {
  supply: ColourSupply
  maxSupply: number | null
  localExceedsCap: boolean
  label: string
} {
  if (args.meta.supply !== 'locked') {
    return {
      supply: 'open',
      maxSupply: null,
      localExceedsCap: false,
      label: 'No supply cap',
    }
  }
  const max = args.meta.maxSupply
  const localExceedsCap = max != null && args.heldUnits > max
  return {
    supply: 'locked',
    maxSupply: max,
    localExceedsCap,
    label:
      max == null
        ? 'Supply locked'
        : localExceedsCap
          ? `Over cap (held ${args.heldUnits} > ${max})`
          : `Supply locked at ${max}`,
  }
}

/** Assert children Σ amt === parents Σ amt. */
export function assertColourAmtConservation(
  parentAmts: number[],
  childAmts: number[],
): void {
  const S = parentAmts.reduce((a, b) => a + b, 0)
  const T = childAmts.reduce((a, b) => a + b, 0)
  if (!Number.isSafeInteger(S) || !Number.isSafeInteger(T) || S !== T) {
    throw new Error(`Token amt not conserved (parents ${S} ≠ children ${T})`)
  }
}

export function aggregateColourTokens(
  tips: ColourTip[],
  metaByOrigin: Map<string, ColourOriginMeta>,
): ColourToken[] {
  const groups = new Map<string, ColourTip[]>()
  for (const tip of tips) {
    if (tip.satoshis !== 1 || !tip.proven) continue
    const origin = normalizeColourOrigin(tip.origin)
    const list = groups.get(origin) ?? []
    list.push(tip)
    groups.set(origin, list)
  }

  const out: ColourToken[] = []
  for (const [origin, list] of groups) {
    const meta = metaByOrigin.get(origin) ?? {
      origin,
      supply: 'open' as const,
      maxSupply: null,
    }
    const balance = list.reduce((sum, t) => sum + tipFaceAmt(t), 0)
    const supplyEval = evaluateColourSupply({
      meta,
      heldUnits: balance,
    })
    const provenanceOk = list.every((t) => t.proven) && !supplyEval.localExceedsCap
    const sym = meta.sym || meta.name || shortColourLabel(origin)
    out.push({
      origin,
      sym,
      tipCount: list.length,
      balance,
      supply: supplyEval.supply,
      maxSupply: supplyEval.maxSupply,
      provenanceOk,
      outpoint: list[0]!.outpoint,
      name: meta.name,
    })
  }

  out.sort((a, b) => b.balance - a.balance || a.sym.localeCompare(b.sym))
  return out
}

export function shortColourLabel(origin: string): string {
  const o = origin.toLowerCase()
  return o.length >= 10 ? `${o.slice(0, 6)}…${o.slice(-4)}` : o
}

export function colourTokenAsFungible(token: ColourToken): {
  tokenId: string
  sym: string
  amt: string
  dec: number
  utxoCount: number
  outpoint: string
  spendKind: 'plain'
  iconUrl?: string
  colourSupply: ColourSupply
  colourMaxSupply: number | null
  colourProvenanceOk: boolean
} {
  return {
    tokenId: token.origin,
    sym: token.sym,
    amt: String(token.balance),
    dec: 0,
    utxoCount: token.tipCount,
    outpoint: token.outpoint,
    spendKind: 'plain',
    iconUrl: token.iconUrl,
    colourSupply: token.supply,
    colourMaxSupply: token.maxSupply,
    colourProvenanceOk: token.provenanceOk,
  }
}

export type ColourTipSelection = {
  selected: ColourTip[]
  selectedSum: number
  change: number
  amount: number
}

/**
 * Greedy largest-first cover of `amount` units. Change = selectedSum − amount.
 */
export function selectColourTipsForAmount(
  tips: ColourTip[],
  amount: number,
): ColourTipSelection {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive whole number of units')
  }
  const usable = tips
    .filter((t) => t.satoshis === 1 && t.proven && tipFaceAmt(t) > 0)
    .sort((a, b) => tipFaceAmt(b) - tipFaceAmt(a))
  const selected: ColourTip[] = []
  let selectedSum = 0
  for (const tip of usable) {
    if (selectedSum >= amount) break
    selected.push(tip)
    selectedSum += tipFaceAmt(tip)
  }
  if (selectedSum < amount) {
    throw new Error(`Need ${amount} units; only ${selectedSum} available`)
  }
  return {
    selected,
    selectedSum,
    change: selectedSum - amount,
    amount,
  }
}

export function tryParseProvenanceFromCi(
  customInstructions: unknown,
): ProvenanceV2 | null {
  const raw = asRecord(customInstructions)
  if (!raw) return null
  const p = raw.provenance
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const v = p as ProvenanceV2
  if (v.v !== 2 || typeof v.origin !== 'string' || typeof v.tip !== 'string') {
    return null
  }
  if (!Array.isArray(v.path) || typeof v.beefB64 !== 'string') return null
  return v
}
