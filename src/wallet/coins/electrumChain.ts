import { Hash } from '@bsv/sdk'
import { failoverLtcChain, type LtcChain } from '../ltc/chain'
import type { HeaderSource } from '../ltc/headers'
import { fromHex, parseLtcHeader, reversed, toHex } from '../ltc/litecoin'

/**
 * A coin's sources spoken to in the Electrum protocol over WebSocket (Fulcrum,
 * ElectrumX). As with Esplora explorers nothing they answer is trusted:
 * headers are checked by the wallet's own chain, transactions by their hash,
 * inclusion by merkle path. A lying server can hide or delay a coin, never
 * credit one.
 */

export type ElectrumCoinChain = LtcChain & Required<Pick<HeaderSource, 'headerRange'>>

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

/** What differs between chains served over Electrum. */
export type ElectrumProfile = {
  /** "Bitcoin Cash", in errors. */
  label: string
  /** The script a payment to `address` locks; Electrum indexes coins by its hash. */
  outputScript(address: string): Uint8Array
  /** Split `count` concatenated headers. Plain chains serve 80 bytes each; Dogecoin appends AuxPoW. */
  splitHeaders?(raw: Uint8Array, count: number): Uint8Array[]
  /** Headers asked for in one call: fewer where each carries AuxPoW. */
  maxHeadersPerCall?: number
  /** Blocks `blockchain.estimatefee` targets. */
  feeTarget?: number
  /** Smallest units per byte: never pay less (the chain's relay floor) or more (a server is not believed). */
  feeRate: { min: number; max: number }
  /** Coins the wallet does not count, e.g. Bitcoin Cash token outputs. */
  skipCoin?(row: Record<string, unknown>): boolean
}

const TIMEOUT_MS = 15_000
/** A socket nobody has used for this long is closed. */
const IDLE_MS = 30_000
const HASH_RE = /^[0-9a-f]{64}$/
const HEX_RE = /^(?:[0-9a-f]{2})+$/
/** Electrum error texts that mean "this server does not know the transaction". */
const UNKNOWN_TX_RE = /no transaction matching|no such mempool or blockchain transaction/i

/** One lazily opened Electrum connection; requests made while it opens wait for it. */
export function electrumSocket(url: string, open: (url: string) => WebSocket = (u) => new WebSocket(u)): Rpc {
  let ws: WebSocket | null = null
  let ready: Promise<WebSocket> | null = null
  let nextId = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const drop = (reason: Error) => {
    ws = null
    ready = null
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(reason)
    }
    pending.clear()
  }

  const connect = () =>
    (ready ??= new Promise<WebSocket>((resolve, reject) => {
      const sock = open(url)
      const timer = setTimeout(() => {
        sock.close()
        reject(new Error(`${url} did not open`))
        drop(new Error(`${url} did not open`))
      }, TIMEOUT_MS)
      sock.onopen = () => {
        clearTimeout(timer)
        ws = sock
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'server.version', params: ['HandCash', '1.4'] }))
        resolve(sock)
      }
      sock.onmessage = (event) => {
        let msg: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined
        if (!p) return
        pending.delete(msg.id!)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${url}: ${msg.error.message ?? 'error'}`))
        else p.resolve(msg.result)
      }
      sock.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`${url} failed`))
      }
      sock.onclose = () => {
        clearTimeout(timer)
        reject(new Error(`${url} closed`))
        drop(new Error(`${url} closed`))
      }
    }))

  return async (method, params) => {
    const sock = await connect()
    if (idle) clearTimeout(idle)
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${url} ${method} timed out`))
      }, TIMEOUT_MS)
      pending.set(id, {
        resolve: (v) => {
          resolve(v)
          armIdle()
        },
        reject: (e) => {
          reject(e)
          armIdle()
        },
        timer,
      })
      sock.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  function armIdle() {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      if (pending.size === 0) ws?.close()
    }, IDLE_MS)
  }
}

/** Electrum's script hash: SHA-256 of the output script, byte-reversed. */
export const electrumScriptHash = (script: Uint8Array): string => toHex(reversed(Uint8Array.from(Hash.sha256(Array.from(script)))))

const split80 = (raw: Uint8Array, count: number): Uint8Array[] => {
  if (raw.length !== count * 80) throw new Error(`${count} headers are ${count * 80} bytes, not ${raw.length}`)
  return Array.from({ length: count }, (_, i) => raw.slice(i * 80, i * 80 + 80))
}

/** A coin over one Electrum endpoint. */
export function electrumCoinChain(rpc: Rpc, profile: ElectrumProfile): ElectrumCoinChain {
  const { label } = profile
  const perCall = profile.maxHeadersPerCall ?? 2016
  const splitHeaders = profile.splitHeaders ?? split80
  const bad = (what: string) => new Error(`The ${label} server returned a bad ${what}`)
  const hash = (value: unknown, what: string): string => {
    const v = String(value).trim().toLowerCase()
    if (!HASH_RE.test(v)) throw bad(what)
    return v
  }
  const height = (value: unknown, what: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad(what)
    return value as number
  }
  /** 80-byte headers this source read, by hash, so `header(hash)` after `blockHashAt` asks nothing more. */
  const seen = new Map<string, Uint8Array>()
  const remember = (raw: Uint8Array) => {
    const plain = raw.slice(0, 80)
    const { hash: id } = parseLtcHeader(plain)
    if (seen.size > 64) seen.delete(seen.keys().next().value!)
    seen.set(id, plain)
    return id
  }
  const unknownTx = (err: unknown): never => {
    if (err instanceof Error && UNKNOWN_TX_RE.test(err.message)) throw new Error(`transaction not found (${err.message})`)
    throw err
  }

  async function headerRange(lo: number, hi: number): Promise<Uint8Array[]> {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi < lo) throw new Error('bad block range')
    const out: Uint8Array[] = []
    for (let start = lo; start <= hi; start += perCall) {
      const count = Math.min(perCall, hi - start + 1)
      const r = (await rpc('blockchain.block.headers', [start, count])) as { count?: number; hex?: string }
      const hex = String(r?.hex ?? '').toLowerCase()
      if (r?.count !== count || !HEX_RE.test(hex)) throw new Error(`The ${label} server returned ${r?.count ?? 0} of ${count} headers`)
      out.push(...splitHeaders(fromHex(hex), count))
    }
    return out
  }

  async function txHeight(txid: string): Promise<number> {
    const h = await rpc('blockchain.transaction.get_height', [hash(txid, 'txid')]).catch(unknownTx)
    if (h === null || h === undefined) throw new Error('transaction not found')
    if (!Number.isSafeInteger(h)) throw bad('transaction height')
    return h as number
  }

  return {
    async tipHeight() {
      const r = (await rpc('blockchain.headers.subscribe', [])) as { height?: unknown }
      const h = height(r?.height, 'tip height')
      if (h === 0) throw bad('tip height')
      return h
    },
    async blockHashAt(at) {
      const [raw] = await headerRange(at, at)
      return remember(raw!)
    },
    async header(blockHash) {
      const raw = seen.get(hash(blockHash, 'block hash'))
      if (!raw) throw new Error(`${label} headers are read by height; ask blockHashAt first`)
      return raw
    },
    async headerPage(top) {
      if (!Number.isSafeInteger(top) || top < 0) throw new Error('bad block height')
      const lo = Math.max(0, top - 9)
      return (await headerRange(lo, top)).map((header, i) => ({ height: lo + i, header }))
    },
    headerRange,
    async txHex(txid) {
      const raw = String(await rpc('blockchain.transaction.get', [hash(txid, 'txid'), false]).catch(unknownTx)).toLowerCase()
      if (!HEX_RE.test(raw)) throw bad('transaction')
      return raw
    },
    async txStatus(txid) {
      const h = await txHeight(txid)
      return h > 0 ? { confirmed: true, blockHeight: h } : { confirmed: false }
    },
    async merkleProof(txid) {
      const at = await txHeight(txid)
      if (at <= 0) throw new Error('the transaction is not in a block yet')
      const p = (await rpc('blockchain.transaction.get_merkle', [hash(txid, 'txid'), at])) as { block_height?: unknown; merkle?: unknown; pos?: unknown }
      if (p?.block_height !== at || !Array.isArray(p.merkle) || !Number.isSafeInteger(p.pos)) throw bad('merkle proof')
      return { blockHeight: at, merkle: p.merkle.map((m) => hash(m, 'merkle sibling')), pos: p.pos as number }
    },
    async addressUtxos(address) {
      const rows = (await rpc('blockchain.scripthash.listunspent', [electrumScriptHash(profile.outputScript(address))])) as Array<Record<string, unknown>>
      if (!Array.isArray(rows)) throw bad('coin list')
      return rows
        .filter((r) => !profile.skipCoin?.(r))
        .map((r) => ({
          txid: hash(r.tx_hash, 'txid'),
          vout: height(r.tx_pos, 'output index'),
          value: height(r.value, 'output value'),
          confirmed: Number(r.height) > 0,
        }))
    },
    async broadcast(rawHex) {
      return hash(await rpc('blockchain.transaction.broadcast', [rawHex]), 'broadcast txid')
    },
    async feeRate() {
      const [relay, estimate] = await Promise.all([
        rpc('blockchain.relayfee', []).catch(() => 0),
        rpc('blockchain.estimatefee', [profile.feeTarget ?? 2]).catch(() => -1),
      ])
      const perKb = Math.max(Number(relay) || 0, Number(estimate) || 0)
      const rate = Math.ceil(Math.round(perKb * 1e8) / 1000)
      const { min, max } = profile.feeRate
      return Number.isFinite(rate) && rate >= min ? Math.min(rate, max) : min
    },
    async scriptHistory(address) {
      const rows = (await rpc('blockchain.scripthash.get_history', [electrumScriptHash(profile.outputScript(address))])) as Array<Record<string, unknown>>
      if (!Array.isArray(rows)) throw bad('history')
      return rows.map((r) => hash(r.tx_hash, 'txid'))
    },
  }
}

/** Ask each server in turn until one answers; safe for the reasons in {@link electrumCoinChain}. */
export function failoverElectrumChain(chains: readonly ElectrumCoinChain[], label: string): ElectrumCoinChain {
  const base = failoverLtcChain(chains)
  return {
    ...base,
    async headerRange(lo, hi) {
      let lastError: unknown
      for (const chain of chains) {
        try {
          return await chain.headerRange(lo, hi)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError ?? new Error(`No ${label} server configured`)
    },
  }
}
