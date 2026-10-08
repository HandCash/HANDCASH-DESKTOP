/**
 * HandCash verified issuers: BAP IDs HandCash vouches for, served by BRC-CLOUD
 * (`GET /v1/identities/verified`) and signed by the HandCash certifier the
 * wallet pins for handle certificates (BRC-3 signature, counterparty `anyone`).
 *
 * The list only adds a checkmark to an identity whose package already proves
 * the signer on this device; it never makes an unconfirmed stamp verified.
 * Unsigned, mis-signed or older-than-seen lists are refused, so a removed
 * entry cannot be replayed. Without a valid list nobody gets a checkmark.
 */
import { ProtoWallet, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { HANDLE_CERTIFIERS } from './handleCertificate'
import { normalizeBapId } from './issuerMetadata'
import type { VerifiedIssuer } from './issuerTrust'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'

export type { VerifiedIssuer }

export type VerifiedIssuerList = {
  v: 1
  updatedAt: string
  entries: VerifiedIssuer[]
  certifier: string
  signature: string
}

const PROTOCOL: [2, string] = [2, 'handcash verified issuers']
const KEY_ID = '1'
const HANDCASH_CERTIFIER_DOMAIN = 'handcash.io'
const REFRESH_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
const STORAGE_KEY = storageRegistry.verifiedIssuers.key

type Stored = { list: VerifiedIssuerList; fetchedAt: number }

let current: Stored | null | undefined
let byBapId = new Map<string, VerifiedIssuer>()
let inFlight: Promise<void> | null = null
let lastAttempt = 0
let generation = 0
const listeners = new Set<() => void>()

export function subscribeVerifiedIssuers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function verifiedIssuersGeneration(): number {
  return generation
}

/** Bytes the certifier signs, rebuilt from the parsed body (BRC-CLOUD `verifiedIssuersMessage`). */
export function verifiedIssuersMessage(list: Pick<VerifiedIssuerList, 'v' | 'updatedAt' | 'entries'>): number[] {
  return Utils.toArray(
    JSON.stringify({
      v: list.v,
      updatedAt: list.updatedAt,
      entries: list.entries.map(({ bapId, name }) => ({ bapId, name })),
    }),
    'utf8',
  )
}

function parseList(raw: unknown): VerifiedIssuerList | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row.v !== 1 || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)))
    return null
  if (typeof row.certifier !== 'string' || typeof row.signature !== 'string') return null
  if (!/^(?:[0-9a-f]{2})+$/i.test(row.signature) || !Array.isArray(row.entries)) return null
  const entries: VerifiedIssuer[] = []
  for (const entry of row.entries as unknown[]) {
    const e = entry as Record<string, unknown> | null
    const bapId = normalizeBapId(e?.bapId)
    if (!bapId || bapId !== e?.bapId || typeof e?.name !== 'string' || !e.name.trim()) return null
    entries.push({ bapId, name: e.name })
  }
  return {
    v: 1,
    updatedAt: row.updatedAt,
    entries,
    certifier: row.certifier.toLowerCase(),
    signature: row.signature.toLowerCase(),
  }
}

/** The list when its signature is the pinned HandCash certifier's; otherwise null. */
export async function verifyVerifiedIssuerList(
  raw: unknown,
  certifier: string = HANDLE_CERTIFIERS[HANDCASH_CERTIFIER_DOMAIN]!,
): Promise<VerifiedIssuerList | null> {
  const list = parseList(raw)
  if (!list || list.certifier !== certifier) return null
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: verifiedIssuersMessage(list),
      signature: Utils.toArray(list.signature, 'hex'),
      protocolID: PROTOCOL,
      keyID: KEY_ID,
      counterparty: certifier,
    })
    return valid ? list : null
  } catch {
    return null
  }
}

function adopt(stored: Stored, persist: boolean): void {
  current = stored
  byBapId = new Map(stored.list.entries.map((entry) => [entry.bapId, entry]))
  if (persist) durableSetItem(STORAGE_KEY, JSON.stringify(stored))
  generation++
  for (const listener of listeners) listener()
}

function loadStored(): void {
  if (current !== undefined) return
  current = null
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<Stored>
    const list = parseList(parsed.list)
    if (!list || typeof parsed.fetchedAt !== 'number') return
    // Anything on the device can write durable storage.
    void verifyVerifiedIssuerList(list).then((ok) => {
      if (ok && (!current || Date.parse(ok.updatedAt) >= Date.parse(current.list.updatedAt)))
        adopt({ list: ok, fetchedAt: parsed.fetchedAt! }, false)
    })
  } catch {
    /* refetched below */
  }
}

/** The newest valid list, kept only when it is not older than what this device has seen. */
export async function refreshVerifiedIssuers(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_BRC_CLOUD_BASE_URL,
): Promise<void> {
  lastAttempt = Date.now()
  const started = performance.now()
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/identities/verified`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = await verifyVerifiedIssuerList(await res.json())
    if (!list) throw new Error('list signature refused')
    if (current && Date.parse(list.updatedAt) < Date.parse(current.list.updatedAt))
      throw new Error(`list ${list.updatedAt} is older than ${current.list.updatedAt}`)
    adopt({ list, fetchedAt: Date.now() }, true)
  } catch (err) {
    console.warn('[verified-issuers] refresh refused', err instanceof Error ? err.message : String(err))
  } finally {
    const ms = Math.round(performance.now() - started)
    if (ms > 250) console.info(`[verified-issuers] refresh done ${ms}ms`)
  }
}

/** Starts a refresh when the list is missing or stale; safe to call on every render pass. */
export function ensureVerifiedIssuersFresh(): void {
  loadStored()
  if (inFlight) return
  const now = Date.now()
  const stale = !current || now - current.fetchedAt > REFRESH_MS
  if (!stale || now - lastAttempt < RETRY_MS) return
  inFlight = refreshVerifiedIssuers().finally(() => {
    inFlight = null
  })
}

export function verifiedIssuerFor(bapId: string): VerifiedIssuer | null {
  loadStored()
  return byBapId.get(bapId) ?? null
}

export function listedVerifiedIssuers(): readonly VerifiedIssuer[] {
  loadStored()
  return current?.list.entries ?? []
}

export function resetVerifiedIssuersForTests(): void {
  current = undefined
  byBapId = new Map()
  inFlight = null
  lastAttempt = 0
  generation = 0
}
