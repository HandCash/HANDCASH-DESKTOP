import { Utils, type PrivateKey } from '@bsv/sdk'
import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { yieldToUi } from '../yieldToUi'
import { HANDCASH_UTXO_SET_URL } from '../walletConfig'
import { gorillaBase, type DiscoveredAddress, type FetchLike } from './discovery'
import type { KeyDeriver } from './importSource'
import { HANDCASH_TEMPLATES } from './pathCatalog'

/**
 * A HandCash account's UTXO set, asked of HandCash's own records and proven
 * by the export's keys (BRC-CLOUD `workers/handcash-utxos`).
 *
 * - Every request is signed in full by keys the export derives, including the
 *   one-time P-256 key the answer is sealed to.
 * - The answer is gzipped and sealed (ECDH → HKDF-SHA-256 → AES-256-GCM); only
 *   this request's one-time private key, never exported, can open it.
 * - The set is a map, never custody: a row counts only when its path derives
 *   the address it names, and coins and items are then read from the chain.
 */

export const UTXO_SET_PROTOCOL = 'HandCash-utxos-v1'
/** Addresses HandCash registers for every account; one match finds it. */
export const UTXO_SET_PROBE_PATHS = ['m/2/0', 'm/1/0', 'm/0/0', 'm/3/0', 'm/4/0', 'm/5/0', 'm/9/0'] as const
const PAGE = 5_000
const MAX_PAGES = 40
const OUTPOINT_CHUNK = 100
const REQUEST_TIMEOUT_MS = 45_000

export type HandCashUtxo = {
  txid: string
  vout: number
  satoshis: number
  script: string
  address: string
  path: string
  type: string
  status: string
  height: number | null
}

export type UtxoSetRefusal =
  /** No HandCash account owns these keys. */
  | 'unknown-keys'
  /** The service did not answer, or answered with an error. */
  | 'unavailable'
  /** The answer did not open or did not parse. */
  | 'bad-response'
  | 'stopped'

export type UtxoSetFetch =
  | { kind: 'fetched'; utxos: HandCashUtxo[] }
  | { kind: 'refused'; reason: UtxoSetRefusal; detail: string }

/** Must match the worker byte for byte. */
export function utxoSetPreimage(request: {
  timestamp: number
  nonce: string
  responseKey: string
  after: string | null
  limit: number
}): string {
  return JSON.stringify([UTXO_SET_PROTOCOL, request.timestamp, request.nonce, request.responseKey, request.after ?? '', request.limit])
}

const enc = new TextEncoder()

const toBase64 = (bytes: Uint8Array): string => Utils.toBase64(Array.from(bytes))
const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => new Uint8Array(Utils.toArray(b64, 'base64'))

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export async function utxoSetSealingKey(
  privateKey: CryptoKey,
  peerPublicKeyRaw: Uint8Array<ArrayBuffer>,
  nonce: string,
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', peerPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(nonce), info: enc.encode(`${UTXO_SET_PROTOCOL} response`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function openSealed(sealed: unknown, privateKey: CryptoKey, nonce: string): Promise<unknown> {
  const { v, key, iv, data } = (sealed ?? {}) as Record<string, unknown>
  if (v !== 1 || typeof key !== 'string' || typeof iv !== 'string' || typeof data !== 'string') {
    throw new Error('not a sealed answer')
  }
  const aes = await utxoSetSealingKey(privateKey, fromBase64(key), nonce)
  const gz = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(nonce) },
    aes,
    fromBase64(data),
  )
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text()) as unknown
}

function parseRow(row: unknown): HandCashUtxo | null {
  const r = (row ?? {}) as Record<string, unknown>
  if (typeof r.txid !== 'string' || !/^[0-9a-f]{64}$/.test(r.txid)) return null
  if (!Number.isSafeInteger(r.vout) || (r.vout as number) < 0) return null
  if (!Number.isSafeInteger(r.satoshis) || (r.satoshis as number) < 0) return null
  if (typeof r.address !== 'string' || typeof r.path !== 'string') return null
  return {
    txid: r.txid,
    vout: r.vout as number,
    satoshis: r.satoshis as number,
    script: typeof r.script === 'string' ? r.script.toLowerCase() : '',
    address: r.address,
    path: r.path,
    type: typeof r.type === 'string' ? r.type : 'standard',
    status: typeof r.status === 'string' ? r.status : 'available',
    height: Number.isSafeInteger(r.height) ? (r.height as number) : null,
  }
}

type PageAnswer =
  | { kind: 'page'; utxos: HandCashUtxo[]; next: string | null }
  | { kind: 'refused'; reason: UtxoSetRefusal; detail: string }

async function requestPage(
  keys: readonly PrivateKey[],
  after: string | null,
  baseUrl: string,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<PageAnswer> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair
  const responseKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  const request = { timestamp: now(), nonce, responseKey, after, limit: PAGE }
  const message = Utils.toArray(utxoSetPreimage(request), 'utf8')
  const body = {
    v: 1,
    ...request,
    proofs: keys.map((key) => ({
      publicKey: key.toPublicKey().toString(),
      signature: key.sign(message).toDER('hex') as string,
    })),
  }
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/utxos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'refused', reason: 'unavailable', detail: err instanceof Error ? err.message : String(err) }
  }
  let answer: unknown
  try {
    answer = await res.json()
  } catch {
    return { kind: 'refused', reason: res.ok ? 'bad-response' : 'unavailable', detail: `HTTP ${res.status}` }
  }
  if (!res.ok) {
    const code = String((answer as { error?: unknown })?.error ?? `HTTP ${res.status}`)
    return { kind: 'refused', reason: code === 'unknown-keys' ? 'unknown-keys' : 'unavailable', detail: code }
  }
  try {
    const opened = (await openSealed(answer, pair.privateKey, nonce)) as { utxos?: unknown; next?: unknown }
    if (!Array.isArray(opened.utxos)) throw new Error('no utxos')
    const utxos = opened.utxos.map(parseRow).filter((u): u is HandCashUtxo => u != null)
    const next = typeof opened.next === 'string' && /^[0-9a-f]{24}$/.test(opened.next) ? opened.next : null
    return { kind: 'page', utxos, next }
  } catch (err) {
    return { kind: 'refused', reason: 'bad-response', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Every page of the account's UTXO set, or why not. */
export async function fetchHandCashUtxoSet(args: {
  deriver: KeyDeriver
  baseUrl?: string
  fetchImpl?: FetchLike
  now?: () => number
  onProgress?: (fetched: number) => void
  shouldStop?: () => boolean
}): Promise<UtxoSetFetch> {
  const startedAt = Date.now()
  const keys = UTXO_SET_PROBE_PATHS.map((path) => args.deriver.privateKeyAt(path))
  const utxos: HandCashUtxo[] = []
  let after: string | null = null
  let pages = 0
  const refuse = (reason: UtxoSetRefusal, detail: string): UtxoSetFetch => {
    appendAppLog('info', `[import] utxo set refused reason=${reason} detail=${detail} after ${Date.now() - startedAt}ms`)
    return { kind: 'refused', reason, detail }
  }
  do {
    if (args.shouldStop?.()) return refuse('stopped', `pages=${pages}`)
    if (pages >= MAX_PAGES) return refuse('bad-response', `more than ${MAX_PAGES} pages`)
    const page = await requestPage(keys, after, args.baseUrl ?? HANDCASH_UTXO_SET_URL, args.fetchImpl ?? fetch, args.now ?? Date.now)
    if (page.kind === 'refused') return refuse(page.reason, page.detail)
    utxos.push(...page.utxos)
    after = page.next
    pages += 1
    args.onProgress?.(utxos.length)
    await yieldToUi()
  } while (after)
  appendAppLog('info', `[import] utxo set done ${Date.now() - startedAt}ms utxos=${utxos.length} pages=${pages}`)
  return { kind: 'fetched', utxos }
}

export type VerifiedUtxoSet = {
  addresses: DiscoveredAddress[]
  /** Addresses HandCash says hold cash or tokens — read live from the chain. */
  cashAddresses: Set<string>
  /** One-sat outputs by address (`txid_vout`) — checked by outpoint. */
  itemOutpoints: Map<string, string[]>
  rejected: number
}

const HANDCASH_PATH = /^m\/(\d)\/(\d{1,9})$/

/**
 * Keep only rows whose path these keys derive to the address and script
 * HandCash names. A row the keys cannot reach is HandCash's claim, not ours.
 */
export function verifyUtxoSet(deriver: KeyDeriver, utxos: readonly HandCashUtxo[]): VerifiedUtxoSet {
  const derived = new Map<string, { address: string; lock: string } | null>()
  const addresses = new Map<string, DiscoveredAddress>()
  const cashAddresses = new Set<string>()
  const itemOutpoints = new Map<string, string[]>()
  const seen = new Set<string>()
  let rejected = 0
  for (const utxo of utxos) {
    const outpoint = `${utxo.txid}_${utxo.vout}`
    if (seen.has(outpoint)) continue
    seen.add(outpoint)
    const m = HANDCASH_PATH.exec(utxo.path)
    let key = derived.get(utxo.path)
    if (key === undefined) {
      key = null
      if (m) {
        const publicKey = deriver.privateKeyAt(utxo.path).toPublicKey()
        key = { address: publicKey.toAddress(), lock: `76a914${publicKey.toHash('hex') as string}88ac` }
      }
      derived.set(utxo.path, key)
    }
    if (!m || !key || key.address !== utxo.address || !utxo.script.includes(key.lock)) {
      rejected += 1
      continue
    }
    if (!addresses.has(key.address)) {
      const template = HANDCASH_TEMPLATES.find((t) => t.id === `handcash-m${m[1]}`)
      addresses.set(key.address, {
        path: utxo.path,
        address: key.address,
        label: template?.label ?? 'HandCash',
        wallets: 'HandCash',
      })
    }
    if (utxo.satoshis === 1) {
      const list = itemOutpoints.get(key.address) ?? []
      list.push(outpoint)
      itemOutpoints.set(key.address, list)
    } else {
      cashAddresses.add(key.address)
    }
  }
  appendAppLog(
    'info',
    `[import] utxo set verified addresses=${addresses.size} cash=${cashAddresses.size} itemAddresses=${itemOutpoints.size} rejected=${rejected}`,
  )
  return { addresses: [...addresses.values()], cashAddresses, itemOutpoints, rejected }
}

/**
 * Which of these outpoints the 1Sat index shows unspent, a hundred per
 * request. One the index does not know is left out — never counted.
 */
export async function readUnspentOutpoints(args: {
  chain: Chain
  outpoints: readonly string[]
  fetchImpl?: FetchLike
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<{ unspent: Set<string>; failed: number; stopped: boolean }> {
  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const unspent = new Set<string>()
  let failed = 0
  let stopped = false
  for (let i = 0; i < args.outpoints.length; i += OUTPOINT_CHUNK) {
    if (args.shouldStop?.()) {
      stopped = true
      break
    }
    const chunk = args.outpoints.slice(i, i + OUTPOINT_CHUNK)
    let rows: unknown = null
    for (let attempt = 0; attempt < 2 && rows == null; attempt += 1) {
      try {
        const res = await fetchImpl(`${gorillaBase(args.chain)}/api/txos/outpoints?script=false`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) rows = await res.json()
      } catch {
        /* one retry, then the chunk counts as failed */
      }
    }
    if (!Array.isArray(rows)) {
      failed += chunk.length
    } else {
      const asked = new Set(chunk)
      for (const row of rows) {
        const { outpoint, spend } = (row ?? {}) as { outpoint?: unknown; spend?: unknown }
        if (typeof outpoint === 'string' && asked.has(outpoint) && !spend) unspent.add(outpoint)
      }
    }
    args.onProgress?.(Math.min(i + OUTPOINT_CHUNK, args.outpoints.length), args.outpoints.length)
    await yieldToUi()
  }
  appendAppLog(
    'info',
    `[import] utxo set items done ${Date.now() - startedAt}ms outpoints=${args.outpoints.length} unspent=${unspent.size} failed=${failed}`,
  )
  return { unspent, failed, stopped }
}
