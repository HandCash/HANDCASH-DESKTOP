import { Utils } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKeyFor } from '../accountLocalKeys'
import { base64ToBytes, bytesToBase64 } from '../base64Binary'
import { durableGetItem, durableRemoveItem, durableSetItem } from '../durableStorage'
import { getWalletRuntime } from '../walletRuntime'
import type { AddressHoldings, HeldTally } from './holdings'
import type { DiscoveredAddress } from './discovery'
import type { HandleProbe } from './handcashHandle'
import {
  sourceFingerprint,
  type ImportSecret,
  type ImportSourceKind,
} from './importSource'

/**
 * Saved Import section sources.
 *
 * Secrets never touch storage in the clear: the whole list is sealed with
 * AES-GCM under a key derived (HKDF-SHA256) from this account's root key, so
 * it opens only inside this unlocked wallet. Imported sources are not
 * accounts — they never enter the switcher or the BRC-100 identity.
 */

export type SourceScan = {
  at: number
  complete: boolean
  checked: number
  addresses: DiscoveredAddress[]
  holdings: AddressHoldings[]
  /** Set when the HandCash history pass covered the reported balance and items. */
  via?: 'handcash-history'
}

export type SweepSummary = {
  at: number
  cashSats: number
  items: number
  tokens: Array<{ tokenId: string; sym: string; amount: string }>
  held: HeldTally
  failed: number
  notes: string[]
}

export type ImportedSource = {
  id: string
  kind: ImportSourceKind
  label: string
  createdAt: number
  /** First address of the key set — recognises a second save of one wallet. */
  fingerprint: string
  secret: ImportSecret
  handle: HandleProbe | null
  scan: SourceScan | null
  lastSweep: SweepSummary | null
}

type SealedRecord = { v: 1; iv: string; ct: string }

const STORE = storageRegistry.importedSources
const HKDF_SALT = new TextEncoder().encode(STORE.key)

type Owner = { identityKey: string; accountIndex: number; chain: 'main' | 'test'; rootKeyHex: string }

function owner(): Owner {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  return {
    identityKey: active.identityKey,
    accountIndex: active.accountIndex,
    chain: active.chain,
    rootKeyHex: active.rootKeyHex,
  }
}

function storageKey(o: Owner): string {
  return accountLocalKeyFor(STORE.key, o)
}

async function sealKey(o: Owner): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(Utils.toArray(o.rootKeyHex, 'hex')),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: new TextEncoder().encode(`${o.chain}:${o.identityKey}`),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function readAll(o: Owner): Promise<ImportedSource[]> {
  const raw = durableGetItem(storageKey(o))
  if (!raw) return []
  const record = JSON.parse(raw) as SealedRecord
  if (record?.v !== 1) throw new Error('Saved imports were written by a newer version')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(base64ToBytes(record.iv)) },
    await sealKey(o),
    Uint8Array.from(base64ToBytes(record.ct)),
  )
  const list = JSON.parse(new TextDecoder().decode(plain)) as unknown
  return Array.isArray(list) ? (list as ImportedSource[]) : []
}

async function writeAll(o: Owner, sources: ImportedSource[]): Promise<void> {
  if (sources.length === 0) {
    durableRemoveItem(storageKey(o))
    notify(sources)
    return
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await sealKey(o),
    new TextEncoder().encode(JSON.stringify(sources)),
  )
  const record: SealedRecord = { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) }
  durableSetItem(storageKey(o), JSON.stringify(record))
  notify(sources)
}

const listeners = new Set<(sources: ImportedSource[]) => void>()

function notify(sources: ImportedSource[]): void {
  for (const listener of listeners) listener(sources)
}

export function subscribeImportedSources(
  listener: (sources: ImportedSource[]) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Serialise read-modify-write so a scan finishing mid-sweep cannot drop an update. */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

export function loadImportedSources(): Promise<ImportedSource[]> {
  return exclusive(() => readAll(owner()))
}

export type AddSourceResult = { source: ImportedSource; existing: boolean }

export function addImportedSource(secret: ImportSecret, label?: string): Promise<AddSourceResult> {
  return exclusive(async () => {
    const o = owner()
    const sources = await readAll(o)
    const fingerprint = sourceFingerprint(secret)
    const prior = sources.find((s) => s.fingerprint === fingerprint && s.kind === secret.kind)
    if (prior) return { source: prior, existing: true }
    const source: ImportedSource = {
      id: crypto.randomUUID(),
      kind: secret.kind,
      label: label?.trim() || defaultLabel(secret.kind, sources),
      createdAt: Date.now(),
      fingerprint,
      secret,
      handle: null,
      scan: null,
      lastSweep: null,
    }
    await writeAll(o, [...sources, source])
    return { source, existing: false }
  })
}

function defaultLabel(kind: ImportSourceKind, sources: ImportedSource[]): string {
  const base = {
    handcash: 'HandCash wallet',
    phrase: 'Phrase wallet',
    twetch: 'Twetch',
    yours: 'Yours wallet',
    wif: 'Private key',
  }[kind]
  const n = sources.filter((s) => s.kind === kind).length
  return n === 0 ? base : `${base} ${n + 1}`
}

export function updateImportedSource(
  id: string,
  patch: Partial<Pick<ImportedSource, 'label' | 'handle' | 'scan' | 'lastSweep'>>,
): Promise<ImportedSource | null> {
  return exclusive(async () => {
    const o = owner()
    const sources = await readAll(o)
    const index = sources.findIndex((s) => s.id === id)
    if (index < 0) return null
    const next = { ...sources[index]!, ...patch }
    sources[index] = next
    await writeAll(o, sources)
    return next
  })
}

export function removeImportedSource(id: string): Promise<void> {
  return exclusive(async () => {
    const o = owner()
    const sources = await readAll(o)
    await writeAll(
      o,
      sources.filter((s) => s.id !== id),
    )
  })
}
