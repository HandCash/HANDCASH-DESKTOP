/**
 * BRC-73 / BRC-116 spendingAuthorization — monthly satoshis grant per origin.
 *
 * Apps declare `{ amount, description }` in their web manifest under
 * `metanet.groupPermissions.spendingAuthorization` (legacy:
 * `babbage.groupPermissions`). On Connect Allow we persist the grant.
 * Auto-pay is still enabled on a payment approve prompt; once on, silent
 * createAction uses this monthly cap instead of the default USD / hours window.
 */
import { normalizeAppHost } from './appIdentity'
import { getSpentSatsSince } from './appActivity'
import { durableGetItem, durableSetItem } from './durableStorage.js'

const STORAGE_KEY = 'handcash.brc100.spendingAuthorization'
/** Keep short — Connect must never wait on this (see requestOriginPermission). */
const MANIFEST_FETCH_MS = 1_500

export type SpendingAuthorizationDeclaration = {
  amountSats: number
  description: string
}

export type SpendingAuthorizationGrant = SpendingAuthorizationDeclaration & {
  grantedAt: number
}

type Store = Record<string, SpendingAuthorizationGrant>

function readStore(): Store {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [origin, value] of Object.entries(parsed as Store)) {
      if (!value || typeof value !== 'object') continue
      const amountSats = Math.trunc(Number(value.amountSats) || 0)
      if (amountSats <= 0) continue
      out[normalizeAppHost(origin)] = {
        amountSats,
        description:
          typeof value.description === 'string' ? value.description.trim() : '',
        grantedAt:
          typeof value.grantedAt === 'number' && Number.isFinite(value.grantedAt)
            ? value.grantedAt
            : Date.now(),
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  durableSetItem(STORAGE_KEY, JSON.stringify(store))
}

/** Parse spendingAuthorization from a web app manifest body. */
export function parseSpendingAuthorizationFromManifest(
  body: unknown,
): SpendingAuthorizationDeclaration | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const root = body as Record<string, unknown>
  const groups: unknown[] = []
  const metanet = root.metanet
  if (metanet && typeof metanet === 'object' && !Array.isArray(metanet)) {
    groups.push((metanet as { groupPermissions?: unknown }).groupPermissions)
  }
  const babbage = root.babbage
  if (babbage && typeof babbage === 'object' && !Array.isArray(babbage)) {
    groups.push((babbage as { groupPermissions?: unknown }).groupPermissions)
  }
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const auth = (group as { spendingAuthorization?: unknown }).spendingAuthorization
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue
    const amount = Math.trunc(Number((auth as { amount?: unknown }).amount) || 0)
    if (amount <= 0) continue
    const description =
      typeof (auth as { description?: unknown }).description === 'string'
        ? (auth as { description: string }).description.trim()
        : ''
    return { amountSats: amount, description }
  }
  return null
}

/**
 * Best-effort fetch of `${origin}/manifest.json` for Connect prompts.
 * Never throws — partners without a manifest simply get no monthly grant UI.
 */
export async function fetchAppSpendingAuthorization(
  origin: string | undefined,
): Promise<SpendingAuthorizationDeclaration | null> {
  const key = normalizeAppHost(origin)
  if (!key || key === 'unknown') return null
  const base = origin?.trim() || `https://${key}`
  let manifestUrl: string
  try {
    manifestUrl = new URL('/manifest.json', base.endsWith('/') ? base : `${base}/`).href
  } catch {
    return null
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MANIFEST_FETCH_MS)
  try {
    const res = await fetch(manifestUrl, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return parseSpendingAuthorizationFromManifest(body)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function getSpendingAuthorizationGrant(
  origin: string | undefined,
): SpendingAuthorizationGrant | null {
  return readStore()[normalizeAppHost(origin)] ?? null
}

export function grantSpendingAuthorization(
  origin: string | undefined,
  declaration: SpendingAuthorizationDeclaration,
): void {
  const key = normalizeAppHost(origin)
  if (!key || key === 'unknown') return
  const amountSats = Math.trunc(declaration.amountSats)
  if (amountSats <= 0) return
  const store = readStore()
  store[key] = {
    amountSats,
    description: declaration.description.trim(),
    grantedAt: Date.now(),
  }
  writeStore(store)
}

export function clearSpendingAuthorization(origin?: string): void {
  if (!origin) {
    writeStore({})
    return
  }
  const store = readStore()
  delete store[normalizeAppHost(origin)]
  writeStore(store)
}

/** Start of the current UTC calendar month (BRC monthly window). */
export function startOfUtcMonth(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/**
 * Whether this createAction fits under the granted monthly satoshis cap.
 * Does not enable silent pay by itself — Auto-pay must also be on.
 */
export function spendingAuthorizationAllowsPayment(
  origin: string | undefined,
  amountSats: number,
): boolean {
  const grant = getSpendingAuthorizationGrant(origin)
  if (!grant) return false
  const sats = Math.max(0, Math.trunc(amountSats))
  if (sats <= 0) return false
  if (sats > grant.amountSats) return false
  const spent = getSpentSatsSince(origin, startOfUtcMonth())
  return spent + sats <= grant.amountSats
}

export function formatSpendingAuthorizationLabel(
  declaration: SpendingAuthorizationDeclaration,
): string {
  const sats = declaration.amountSats
  const bsv = (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  const desc = declaration.description.trim()
  return desc
    ? `Monthly spend limit: ${bsv} BSV (${sats.toLocaleString()} sats) — ${desc}`
    : `Monthly spend limit: ${bsv} BSV (${sats.toLocaleString()} sats)`
}
