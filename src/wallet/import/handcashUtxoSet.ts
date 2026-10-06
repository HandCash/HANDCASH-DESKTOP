import { Utils, type PrivateKey } from '@bsv/sdk'
import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { uiBudgetExpired, yieldToUi } from '../yieldToUi'
import { HANDCASH_UTXO_SET_URL } from '../walletConfig'
import {
  SPENT_PROBE_BATCH,
  TERANODE_PROBE_BATCH,
  parseBulkSpentEntry,
  parseTeranodeUtxoEntry,
  teranodeUtxoHosts,
  teranodeUtxoRequestBody,
  type OutpointSpendProbe,
} from '../createActionInputFate'
import { gorillaBase, wocBulkPost, type DiscoveredAddress, type FetchLike } from './discovery'
import type { KeyDeriver } from './importSource'
import { HANDCASH_TEMPLATES } from './pathCatalog'
import { importItemFacts, type ImportItemFacts } from './importItem'
import { cosignedOwnerHash } from '../mneeTip'

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

/** A plain output over one sat; `outpoint` is `txid_vout`. */
export type CashOutput = { outpoint: string; txid: string; vout: number; satoshis: number }

export type VerifiedUtxoSet = {
  addresses: DiscoveredAddress[]
  /** Plain outputs over one sat, by address — checked by outpoint. */
  cashOutputs: Map<string, CashOutput[]>
  /** One-sat outputs by address (`txid_vout`) — checked by outpoint. */
  itemOutpoints: Map<string, string[]>
  /** Addresses holding tokens or multi-sat inscriptions — read in full from the chain. */
  readAddresses: Set<string>
  /** Addresses holding cosigned MNEE — read from MNEE's own index. */
  mneeAddresses: Set<string>
  rejected: number
}

const HANDCASH_PATH = /^m\/(\d)\/(\d{1,9})$/

function p2pkhLockFor(address: string): string | null {
  try {
    const { data } = Utils.fromBase58Check(address)
    const hash = typeof data === 'string' ? data : Utils.toHex(data)
    return hash.length === 40 ? `76a914${hash}88ac` : null
  } catch {
    return null
  }
}

/**
 * Keep only rows whose path these keys derive to the address and script
 * HandCash names. A row the keys cannot reach is HandCash's claim, not ours.
 *
 * `known` is path → address from this source's own last scan, sealed on this
 * device and derived by these same keys; those paths are not derived again.
 * A phone pays ~20ms per derivation, which made every rescan and item list of
 * a 2,000-address account re-spend most of a minute.
 */
export async function verifyUtxoSet(
  deriver: KeyDeriver,
  utxos: readonly HandCashUtxo[],
  known: ReadonlyMap<string, string> = new Map(),
): Promise<VerifiedUtxoSet> {
  const startedAt = Date.now()
  const derived = new Map<string, { address: string; lock: string } | null>()
  let derivations = 0
  const addresses = new Map<string, DiscoveredAddress>()
  const cashOutputs = new Map<string, CashOutput[]>()
  const itemOutpoints = new Map<string, string[]>()
  const readAddresses = new Set<string>()
  const mneeAddresses = new Set<string>()
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
      const knownAddress = m ? known.get(utxo.path) : undefined
      const knownLock = knownAddress ? p2pkhLockFor(knownAddress) : null
      if (knownAddress && knownLock) {
        key = { address: knownAddress, lock: knownLock }
      } else if (m) {
        if (uiBudgetExpired()) await yieldToUi()
        const publicKey = deriver.privateKeyAt(utxo.path).toPublicKey()
        key = { address: publicKey.toAddress(), lock: `76a914${publicKey.toHash('hex') as string}88ac` }
        derivations += 1
      }
      derived.set(utxo.path, key)
    }
    if (!m || !key || key.address !== utxo.address) {
      rejected += 1
      continue
    }
    // Cosigned (MNEE) outputs carry the same owner hash under CHECKSIGVERIFY +
    // approver CHECKSIG. Routing only — the sweep re-reads every script.
    const plain = utxo.script.includes(key.lock)
    const cosignedOwner = plain ? null : cosignedOwnerHash(utxo.script)
    const mnee = cosignedOwner != null && `76a914${cosignedOwner}88ac` === key.lock
    if (!plain && !mnee) {
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
    if (mnee) {
      mneeAddresses.add(key.address)
    } else if (utxo.type === 'instrument' || (utxo.satoshis > 1 && utxo.type !== 'standard')) {
      readAddresses.add(key.address)
    } else if (utxo.satoshis === 1) {
      const list = itemOutpoints.get(key.address) ?? []
      list.push(outpoint)
      itemOutpoints.set(key.address, list)
    } else {
      const list = cashOutputs.get(key.address) ?? []
      list.push({ outpoint, txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis })
      cashOutputs.set(key.address, list)
    }
  }
  appendAppLog(
    'info',
    `[import] utxo set verified addresses=${addresses.size} cash=${cashOutputs.size} itemAddresses=${itemOutpoints.size} read=${readAddresses.size} rejected=${rejected} derived=${derivations} mnee=${mneeAddresses.size} done ${Date.now() - startedAt}ms`,
  )
  return { addresses: [...addresses.values()], cashOutputs, itemOutpoints, readAddresses, mneeAddresses, rejected }
}

const TERANODE_CHUNK = TERANODE_PROBE_BATCH
const WOC_CHUNK = SPENT_PROBE_BATCH

/**
 * Which cash outputs the chain shows unspent, by outpoint: a Teranode node a
 * hundred at a time, then WhatsOnChain for any the node could not place.
 * `unknown` is what neither answered; those addresses are read in full.
 */
export async function readUnspentCash(args: {
  chain: Chain
  outputs: readonly CashOutput[]
  fetchImpl?: FetchLike
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<{ unspent: Set<string>; unknown: Set<string>; stopped: boolean }> {
  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const answers = new Map<string, OutpointSpendProbe['kind']>()
  let stopped = false
  const stop = () => (stopped ||= args.shouldStop?.() === true)

  for (let i = 0; i < args.outputs.length && !stop(); i += TERANODE_CHUNK) {
    const chunk = args.outputs.slice(i, i + TERANODE_CHUNK)
    for (const host of teranodeUtxoHosts(args.chain)) {
      try {
        const res = await fetchImpl(`${host}/utxos/json`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
          body: teranodeUtxoRequestBody(chunk),
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) continue
        const body = (await res.json()) as unknown
        if (!Array.isArray(body) || body.length !== chunk.length) continue
        chunk.forEach((o, j) => answers.set(o.outpoint, parseTeranodeUtxoEntry(body[j], '').kind))
        break
      } catch {
        /* the next node, then WhatsOnChain */
      }
    }
    args.onProgress?.(Math.min(i + TERANODE_CHUNK, args.outputs.length), args.outputs.length)
    await yieldToUi()
  }

  const rest = args.outputs.filter((o) => (answers.get(o.outpoint) ?? 'unknown') === 'unknown')
  for (let i = 0; i < rest.length && !stop(); i += WOC_CHUNK) {
    const chunk = rest.slice(i, i + WOC_CHUNK)
    const asked = new Set(chunk.map((o) => o.outpoint))
    try {
      const body = await wocBulkPost(args.chain, '/utxos/spent', { utxos: chunk.map(({ txid, vout }) => ({ txid, vout })) }, fetchImpl)
      for (const entry of Array.isArray(body) ? body : []) {
        const utxo = (entry as { utxo?: { txid?: unknown; vout?: unknown } } | null)?.utxo
        const outpoint = `${String(utxo?.txid ?? '').toLowerCase()}_${Number(utxo?.vout)}`
        if (asked.has(outpoint)) answers.set(outpoint, parseBulkSpentEntry(entry, '').kind)
      }
    } catch {
      /* stays unknown */
    }
    args.onProgress?.(Math.min(i + WOC_CHUNK, rest.length), rest.length)
    await yieldToUi()
  }

  const unspent = new Set<string>()
  const unknown = new Set<string>()
  for (const o of args.outputs) {
    const kind = answers.get(o.outpoint) ?? 'unknown'
    if (kind === 'unspent') unspent.add(o.outpoint)
    else if (kind === 'unknown') unknown.add(o.outpoint)
  }
  appendAppLog(
    'info',
    `[import] utxo set cash done ${Date.now() - startedAt}ms outputs=${args.outputs.length} unspent=${unspent.size} unknown=${unknown.size} viaExplorer=${rest.length}`,
  )
  return { unspent, unknown, stopped }
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
  /** Each chunk's unspent outpoints as it lands, for a list that fills in. */
  onUnspent?: (found: ReadonlyArray<{ outpoint: string; facts: ImportItemFacts }>) => void
  shouldStop?: () => boolean
}): Promise<{
  unspent: Set<string>
  /** Index facts for each unspent outpoint, for the item browser. */
  facts: Map<string, ImportItemFacts>
  failed: number
  stopped: boolean
}> {
  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const unspent = new Set<string>()
  const facts = new Map<string, ImportItemFacts>()
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
      const found: Array<{ outpoint: string; facts: ImportItemFacts }> = []
      for (const row of rows) {
        const { outpoint, spend } = (row ?? {}) as { outpoint?: unknown; spend?: unknown }
        if (typeof outpoint === 'string' && asked.has(outpoint) && !spend && !unspent.has(outpoint)) {
          const rowFacts = importItemFacts(row, outpoint)
          unspent.add(outpoint)
          facts.set(outpoint, rowFacts)
          found.push({ outpoint, facts: rowFacts })
        }
      }
      if (found.length > 0) args.onUnspent?.(found)
    }
    args.onProgress?.(Math.min(i + OUTPOINT_CHUNK, args.outpoints.length), args.outpoints.length)
    await yieldToUi()
  }
  appendAppLog(
    'info',
    `[import] utxo set items done ${Date.now() - startedAt}ms outpoints=${args.outpoints.length} unspent=${unspent.size} failed=${failed}`,
  )
  return { unspent, facts, failed, stopped }
}
