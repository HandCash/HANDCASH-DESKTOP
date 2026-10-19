import { PUBLIC_BRC_CLOUD_ORIGIN } from '../walletConfig'
import { fromHex, parseLtcHeader } from './litecoin'

/**
 * What the bridge asks a Litecoin explorer. Nothing it answers is trusted:
 * every deposit is re-checked against headers and proof of work in
 * `verify.ts`, so a lying explorer can only hide a deposit or delay it.
 */
export type LtcChain = {
  tipHeight(): Promise<number>
  blockHashAt(height: number): Promise<string>
  header(blockHash: string): Promise<Uint8Array>
  /** The headers of blocks `top` down to `top - 9`, each rebuilt and checked to hash to the block the explorer named. */
  headerPage(top: number): Promise<Array<{ height: number; header: Uint8Array }>>
  txHex(txid: string): Promise<string>
  txStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number }>
  merkleProof(txid: string): Promise<{ blockHeight: number; merkle: string[]; pos: number }>
  addressUtxos(address: string): Promise<Array<{ txid: string; vout: number; value: number; confirmed: boolean }>>
  broadcast(rawHex: string): Promise<string>
  /** Litoshi per virtual byte for confirmation within about an hour. */
  feeRate(): Promise<number>
  /** Every transaction that pays or spends `address`, by txid. Read to find who spent an output; each answer is fetched and checked by hash. */
  scriptHistory?(address: string): Promise<string[]>
}

export const LITECOINSPACE_API = 'https://litecoinspace.org/api'
/** BRC-CLOUD's Esplora-shaped Litecoin route: litecoinspace, else Blockbook (which sends no CORS headers). */
export const BRC_CLOUD_LTC_API = `${PUBLIC_BRC_CLOUD_ORIGIN}/v1/ltc`
const TIMEOUT_MS = 15_000
const HASH_RE = /^[0-9a-f]{64}$/

async function call(base: string, path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Litecoin explorer ${path.split('/').slice(0, 3).join('/')} ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`)
    }
    return res
  } finally {
    clearTimeout(timer)
  }
}

const text = async (base: string, path: string) => (await (await call(base, path)).text()).trim()
const json = async <T>(base: string, path: string) => (await (await call(base, path)).json()) as T

function hash(value: string, what: string): string {
  const v = value.trim().toLowerCase()
  if (!HASH_RE.test(v)) throw new Error(`The Litecoin explorer returned a bad ${what}`)
  return v
}

type EsploraBlock = {
  id?: string
  height?: number
  version?: number
  previousblockhash?: string
  merkle_root?: string
  timestamp?: number
  bits?: number
  nonce?: number
}

const u32le = (n: number) => {
  const v = n >>> 0
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

/** The 80-byte header an Esplora block row describes field by field, refused unless it hashes to the row's id. */
export function headerFromEsplora(row: EsploraBlock): Uint8Array {
  const prev = row.previousblockhash ?? '0'.repeat(64)
  const ints = [row.version, row.timestamp, row.bits, row.nonce, row.height]
  if (!HASH_RE.test(String(row.id)) || !HASH_RE.test(prev) || !HASH_RE.test(String(row.merkle_root)) || !ints.every((n) => Number.isSafeInteger(n))) {
    throw new Error('The Litecoin explorer returned a bad block row')
  }
  const raw = Uint8Array.from([
    ...u32le(row.version!),
    ...fromHex(prev).reverse(),
    ...fromHex(row.merkle_root!).reverse(),
    ...u32le(row.timestamp!),
    ...u32le(row.bits!),
    ...u32le(row.nonce!),
  ])
  if (parseLtcHeader(raw).hash !== row.id) throw new Error(`The Litecoin explorer's block ${row.height} does not hash to its id`)
  return raw
}

/** An Esplora-compatible Litecoin explorer (litecoinspace.org by default). */
export function esploraLtcChain(base = LITECOINSPACE_API): LtcChain {
  return {
    async tipHeight() {
      const height = Number(await text(base, '/blocks/tip/height'))
      if (!Number.isSafeInteger(height) || height <= 0) throw new Error('The Litecoin explorer returned a bad tip height')
      return height
    },
    async blockHashAt(height) {
      return hash(await text(base, `/block-height/${height}`), 'block hash')
    },
    async header(blockHash) {
      return fromHex(await text(base, `/block/${hash(blockHash, 'block hash')}/header`))
    },
    async headerPage(top) {
      if (!Number.isSafeInteger(top) || top < 0) throw new Error('bad block height')
      const rows = await json<EsploraBlock[]>(base, `/blocks/${top}`)
      if (!Array.isArray(rows)) throw new Error('The Litecoin explorer returned a bad block page')
      return rows.map((row) => ({ height: Number(row.height), header: headerFromEsplora(row) }))
    },
    async txHex(txid) {
      return text(base, `/tx/${hash(txid, 'txid')}/hex`)
    },
    async txStatus(txid) {
      const id = hash(txid, 'txid')
      const s = await json<{ confirmed?: boolean; block_height?: number }>(base, `/tx/${id}/status`)
      if (s.confirmed === true) return { confirmed: true, ...(typeof s.block_height === 'number' ? { blockHeight: s.block_height } : {}) }
      // litecoinspace answers `{"confirmed":false}` for a txid it has never seen; only the body 404s.
      await text(base, `/tx/${id}/hex`)
      return { confirmed: false }
    },
    async merkleProof(txid) {
      const p = await json<{ block_height?: number; merkle?: string[]; pos?: number }>(base, `/tx/${hash(txid, 'txid')}/merkle-proof`)
      if (typeof p.block_height !== 'number' || !Array.isArray(p.merkle) || typeof p.pos !== 'number') {
        throw new Error('The Litecoin explorer returned a bad merkle proof')
      }
      return { blockHeight: p.block_height, merkle: p.merkle.map((m) => hash(m, 'merkle sibling')), pos: p.pos }
    },
    async addressUtxos(address) {
      const rows = await json<Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>>(
        base,
        `/address/${encodeURIComponent(address)}/utxo`,
      )
      return rows.map((r) => ({ txid: hash(r.txid, 'txid'), vout: r.vout, value: r.value, confirmed: r.status?.confirmed === true }))
    },
    async broadcast(rawHex) {
      const res = await call(base, '/tx', { method: 'POST', body: rawHex, headers: { 'content-type': 'text/plain' } })
      return hash(await res.text(), 'broadcast txid')
    },
    async feeRate() {
      const fees = await json<{ hourFee?: number; halfHourFee?: number }>(base, '/v1/fees/recommended').catch(() => ({}) as { hourFee?: number })
      const rate = Number(fees.hourFee ?? 0)
      return Number.isFinite(rate) && rate >= 1 ? Math.ceil(rate) : 1
    },
    async scriptHistory(address) {
      const rows = await json<Array<{ txid?: string }>>(base, `/address/${encodeURIComponent(address)}/txs`)
      if (!Array.isArray(rows)) throw new Error('The Litecoin explorer returned a bad history')
      return rows.map((r) => hash(String(r.txid), 'txid'))
    },
  }
}

/**
 * Ask each explorer in turn until one answers. Safe because no answer is
 * trusted (see {@link LtcChain}); a broadcast tried twice is the same
 * transaction, so the second explorer at worst reports it already known.
 */
export function failoverLtcChain(chains: readonly LtcChain[]): LtcChain {
  type Methods = Required<LtcChain>
  const first = <K extends keyof Methods>(method: K) =>
    (async (...args: Parameters<Methods[K]>) => {
      let lastError: unknown
      for (const chain of chains) {
        try {
          return await (chain[method] as (...a: Parameters<Methods[K]>) => ReturnType<Methods[K]>)(...args)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError ?? new Error('No Litecoin explorer configured')
    }) as Methods[K]
  return {
    tipHeight: first('tipHeight'),
    blockHashAt: first('blockHashAt'),
    header: first('header'),
    headerPage: first('headerPage'),
    txHex: first('txHex'),
    txStatus: first('txStatus'),
    merkleProof: first('merkleProof'),
    addressUtxos: first('addressUtxos'),
    broadcast: first('broadcast'),
    feeRate: first('feeRate'),
    ...(chains.some((c) => c.scriptHistory)
      ? { scriptHistory: first('scriptHistory') }
      : {}),
  }
}

/** The wallet's Litecoin explorers: litecoinspace directly, then through BRC-CLOUD. */
export function defaultLtcChain(): LtcChain {
  return failoverLtcChain([esploraLtcChain(LITECOINSPACE_API), esploraLtcChain(BRC_CLOUD_LTC_API)])
}
