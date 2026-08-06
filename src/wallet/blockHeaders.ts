/**
 * Block headers for heights the Chaintracks host has not reached yet.
 *
 * Bringing an ordinal in is a two-step conversation with the chain. First the
 * merkle root is checked — `chainTrackerFallback` handles that and no longer
 * denies a proof just because a tracker is behind. Then, and only for an
 * internalized transaction, the storage layer records *which block* the proof
 * belongs to: `findOrInsertProvenTxFromBump` asks `getHeaderForHeight` for the
 * 80-byte header so it can store its hash alongside the proven tx.
 *
 * That second call reaches straight into `options.chaintracks`, past every
 * failover, and returns undefined for any height above the host's store — which
 * the toolbox reports as "The hash parameter must be valid height 'N' on mined
 * chain main". Ordinary payments never notice, because a P2PKH sweep is a
 * `createAction` and stops after the root check. Ordinals always notice. That
 * asymmetry is exactly what the user saw: money arrived, collectables did not.
 *
 * A header sourced from a public API is only accepted when it proves itself:
 * the 80 bytes must hash to the hash the API reported, and that hash must
 * satisfy the proof-of-work its own `bits` field claims. A forged header would
 * have to be mined.
 */
import { Hash, Utils } from '@bsv/sdk'

import { appendAppLog } from './appLog'
import type { Chain } from './vault'

/** Shape `Services.toBinaryBaseBlockHeader` expects, plus the identity fields. */
export type FetchedBlockHeader = {
  height: number
  hash: string
  version: number
  previousHash: string
  merkleRoot: string
  time: number
  bits: number
  nonce: number
}

const REQUEST_TIMEOUT_MS = 8_000
const SOURCE_COOLDOWN_MS = 60_000
const HEADER_CACHE_MAX = 200

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function num(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hex32(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase()
  }
  return null
}

/** `bits` arrives as compact-target hex ("182a891d") from both providers. */
function bitsValue(body: Record<string, unknown>): number | null {
  const raw = body.bits
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^[0-9a-fA-F]{1,8}$/.test(raw)) return Number.parseInt(raw, 16)
  return null
}

function parseHeader(body: Record<string, unknown> | null, height: number): FetchedBlockHeader | null {
  if (body == null) return null
  const hash = hex32(body, 'hash')
  const previousHash = hex32(body, 'previousblockhash', 'previousBlockHash')
  const merkleRoot = hex32(body, 'merkleroot', 'merkleRoot')
  const version = num(body, 'version')
  const time = num(body, 'time')
  const nonce = num(body, 'nonce')
  const bits = bitsValue(body)
  const reported = num(body, 'height')
  if (
    hash == null ||
    previousHash == null ||
    merkleRoot == null ||
    version == null ||
    time == null ||
    nonce == null ||
    bits == null ||
    reported !== height
  ) {
    return null
  }
  return { height, hash, version, previousHash, merkleRoot, time, bits, nonce }
}

/** The canonical 80 bytes, hashes reversed into serialized byte order. */
function serialize(header: FetchedBlockHeader): number[] {
  const writer = new Utils.Writer()
  writer.writeUInt32LE(header.version)
  writer.writeReverse(Utils.toArray(header.previousHash, 'hex'))
  writer.writeReverse(Utils.toArray(header.merkleRoot, 'hex'))
  writer.writeUInt32LE(header.time)
  writer.writeUInt32LE(header.bits)
  writer.writeUInt32LE(header.nonce)
  return writer.toArray()
}

/** Compact-bits target, per the Bitcoin block header encoding. */
function targetFromBits(bits: number): bigint {
  const exponent = BigInt(bits >>> 24)
  const mantissa = BigInt(bits & 0x00ffffff)
  return exponent <= 3n
    ? mantissa >> (8n * (3n - exponent))
    : mantissa << (8n * (exponent - 3n))
}

/**
 * Accept the header only if it is the block it claims to be.
 *
 * Hashing the serialized bytes back to the advertised hash catches a provider
 * that reshuffled a field or a parse that read the wrong key; requiring that
 * hash to clear the target its own `bits` encode means a fabricated header
 * would need real proof-of-work behind it.
 */
function selfProving(header: FetchedBlockHeader): boolean {
  const bytes = serialize(header)
  if (bytes.length !== 80) return false
  const computed = Utils.toHex(Hash.hash256(bytes).reverse())
  if (computed !== header.hash) return false
  const target = targetFromBits(header.bits)
  return target > 0n && BigInt(`0x${header.hash}`) <= target
}

type HeaderSource = {
  name: string
  url: (height: number) => string
}

function sourcesFor(chain: Chain): HeaderSource[] {
  const woc = `https://api.whatsonchain.com/v1/bsv/${chain === 'main' ? 'main' : 'test'}`
  return [
    // Same ordering rationale as the chain tracker: WhatsOnChain carries most of
    // the toolbox's other traffic and is the first to rate-limit on a busy device.
    ...(chain === 'main'
      ? [{ name: 'Bitails', url: (h: number) => `https://api.bitails.io/block/height/${h}` }]
      : []),
    { name: 'WhatsOnChain', url: (h: number) => `${woc}/block/${h}/header` },
  ]
}

const cache = new Map<string, FetchedBlockHeader>()
const cooldownUntil = new Map<string, number>()
const inFlight = new Map<string, Promise<FetchedBlockHeader | undefined>>()
let loggedFallback = false

function remember(key: string, header: FetchedBlockHeader): void {
  cache.set(key, header)
  while (cache.size > HEADER_CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/**
 * The header at `height` from a public source, or undefined if none can prove one.
 *
 * Concurrent callers for the same height share one request — an ingest pass
 * routinely internalizes several outputs from the same block at once.
 */
export async function fetchBlockHeaderForHeight(
  chain: Chain,
  height: number,
): Promise<FetchedBlockHeader | undefined> {
  if (!Number.isInteger(height) || height < 0) return undefined
  const key = `${chain}:${height}`

  const cached = cache.get(key)
  if (cached != null) return cached

  const pending = inFlight.get(key)
  if (pending != null) return await pending

  const run = (async (): Promise<FetchedBlockHeader | undefined> => {
    for (const source of sourcesFor(chain)) {
      if (Date.now() < (cooldownUntil.get(source.name) ?? 0)) continue
      const header = parseHeader(await fetchJson(source.url(height)), height)
      if (header == null) {
        cooldownUntil.set(source.name, Date.now() + SOURCE_COOLDOWN_MS)
        continue
      }
      if (!selfProving(header)) {
        appendAppLog('warn', `[headers] ${source.name} served an unverifiable header at ${height}`)
        continue
      }
      if (!loggedFallback) {
        loggedFallback = true
        appendAppLog('info', `[headers] serving headers from ${source.name} while Chaintracks lags`)
      }
      remember(key, header)
      return header
    }
    return undefined
  })()

  inFlight.set(key, run)
  try {
    return await run
  } finally {
    inFlight.delete(key)
  }
}
