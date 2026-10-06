import { P2PKH, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))

import type { KeyDeriver } from './importSource'
import { resetDiscoveryPacingForTests } from './discovery'
import {
  UTXO_SET_PROBE_PATHS,
  fetchHandCashUtxoSet,
  readUnspentCash,
  readUnspentOutpoints,
  type CashOutput,
  utxoSetPreimage,
  utxoSetSealingKey,
  verifyUtxoSet,
  type HandCashUtxo,
} from './handcashUtxoSet'

function makeDeriver(): KeyDeriver {
  const keys = new Map<string, PrivateKey>()
  return {
    templates: [],
    fixed: [],
    identity: null,
    privateKeyAt: (path) => {
      let key = keys.get(path)
      if (!key) keys.set(path, (key = PrivateKey.fromRandom()))
      return key
    },
  }
}

const enc = new TextEncoder()
const b64 = (bytes: Uint8Array) => Utils.toBase64(Array.from(bytes))
const unb64 = (s: string) => new Uint8Array(Utils.toArray(s, 'base64'))

async function seal(value: unknown, responseKey: string, nonce: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const key = await utxoSetSealingKey(pair.privateKey, unb64(responseKey), nonce)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const gz = new Uint8Array(
    await new Response(new Blob([enc.encode(JSON.stringify(value))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  )
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(nonce) }, key, gz))
  return { v: 1, key: b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), iv: b64(iv), data: b64(data) }
}

type Body = {
  v: number
  timestamp: number
  nonce: string
  responseKey: string
  after: string | null
  limit: number
  proofs: Array<{ publicKey: string; signature: string }>
}

/** The worker's contract: every proof over the whole request, answer sealed to its key. */
function fakeWorker(pages: Array<{ utxos: unknown[]; next: string | null }>, opts: { tamper?: boolean; sealTo?: string } = {}) {
  const seen: Body[] = []
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body
    seen.push(body)
    const message = Utils.toArray(utxoSetPreimage(body), 'utf8')
    for (const proof of body.proofs) {
      if (!PublicKey.fromString(proof.publicKey).verify(message, Signature.fromDER(proof.signature, 'hex'))) {
        return new Response(JSON.stringify({ error: 'bad-signature' }), { status: 401 })
      }
    }
    const page = pages[seen.length - 1]
    const sealed = await seal(page, opts.sealTo ?? body.responseKey, body.nonce)
    if (opts.tamper) sealed.data = b64(unb64(sealed.data).map((b, i) => (i === 5 ? b ^ 1 : b)))
    return new Response(JSON.stringify(sealed))
  })
  return { fetchImpl, seen }
}

const utxo = (n: number, over: Partial<HandCashUtxo> = {}): HandCashUtxo => ({
  txid: n.toString(16).padStart(64, '0'),
  vout: 0,
  satoshis: 1,
  script: '',
  address: '',
  path: 'm/9/0',
  type: 'standard',
  status: 'available',
  height: 900_000,
  ...over,
})

describe('fetchHandCashUtxoSet', () => {
  it('signs every request with the probe keys and opens every sealed page', async () => {
    const deriver = makeDeriver()
    const worker = fakeWorker([
      { utxos: [utxo(1)], next: 'a'.repeat(24) },
      { utxos: [utxo(2), { txid: 'bad' }], next: null },
    ])
    const progress: number[] = []
    const set = await fetchHandCashUtxoSet({ deriver, baseUrl: 'https://utxos.test', fetchImpl: worker.fetchImpl, onProgress: (n) => progress.push(n) })

    expect(set).toEqual({ kind: 'fetched', utxos: [utxo(1), utxo(2)] })
    expect(progress).toEqual([1, 2])
    expect(worker.seen.map((b) => b.after)).toEqual([null, 'a'.repeat(24)])
    expect(worker.seen[0].proofs.map((p) => PublicKey.fromString(p.publicKey).toAddress())).toEqual(
      UTXO_SET_PROBE_PATHS.map((path) => deriver.privateKeyAt(path).toPublicKey().toAddress()),
    )
    expect(new Set(worker.seen.map((b) => b.responseKey)).size).toBe(2)
    expect(new Set(worker.seen.map((b) => b.nonce)).size).toBe(2)
  })

  it('refuses an answer that was altered or sealed to another key', async () => {
    const tampered = fakeWorker([{ utxos: [utxo(1)], next: null }], { tamper: true })
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: tampered.fetchImpl })).toMatchObject({
      kind: 'refused',
      reason: 'bad-response',
    })
    const stranger = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const sealTo = b64(new Uint8Array(await crypto.subtle.exportKey('raw', stranger.publicKey)))
    const misdirected = fakeWorker([{ utxos: [utxo(1)], next: null }], { sealTo })
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: misdirected.fetchImpl })).toMatchObject({
      kind: 'refused',
      reason: 'bad-response',
    })
  })

  it('names why the set could not be had', async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: answer(404, { error: 'unknown-keys' }) })).toMatchObject({
      reason: 'unknown-keys',
    })
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: answer(502, { error: 'database-unavailable' }) })).toMatchObject({
      reason: 'unavailable',
      detail: 'database-unavailable',
    })
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: offline })).toMatchObject({ reason: 'unavailable' })
    expect(await fetchHandCashUtxoSet({ deriver: makeDeriver(), fetchImpl: offline, shouldStop: () => true })).toMatchObject({
      reason: 'stopped',
    })
  })
})

describe('verifyUtxoSet', () => {
  it('keeps only rows whose path these keys derive to the named address and script', async () => {
    const deriver = makeDeriver()
    const at = (path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()
    const lock = (path: string) => new P2PKH().lock(at(path)).toHex()
    const inscribed = (path: string) => `0063036f7264510a746578742f706c61696e000268696800${lock(path)}`
    const verified = await verifyUtxoSet(deriver, [
      utxo(1, { path: 'm/0/3', address: at('m/0/3'), script: lock('m/0/3'), satoshis: 5_000 }),
      utxo(2, { path: 'm/9/7', address: at('m/9/7'), script: inscribed('m/9/7') }),
      utxo(2, { path: 'm/9/7', address: at('m/9/7'), script: inscribed('m/9/7') }),
      utxo(3, { path: 'm/9/7', address: at('m/9/7'), script: inscribed('m/9/7') }),
      utxo(4, { path: 'm/1/2', address: at('m/1/9'), script: lock('m/1/9') }),
      utxo(5, { path: 'm/1/2', address: at('m/1/2'), script: lock('m/1/9') }),
      utxo(6, { path: "m/44'/0'/0'/0/0", address: '1x', script: '' }),
      utxo(7, { path: 'm/7/0', address: at('m/7/0'), script: inscribed('m/7/0'), type: 'instrument' }),
      utxo(8, { path: 'm/9/8', address: at('m/9/8'), script: inscribed('m/9/8'), satoshis: 546, type: 'ordinal' }),
    ])
    expect(verified.addresses.map((a) => [a.path, a.label])).toEqual([
      ['m/0/3', 'HandCash'],
      ['m/9/7', 'HandCash items'],
      ['m/7/0', expect.any(String)],
      ['m/9/8', 'HandCash items'],
    ])
    expect([...verified.cashOutputs]).toEqual([
      [at('m/0/3'), [{ outpoint: `${utxo(1).txid}_0`, txid: utxo(1).txid, vout: 0, satoshis: 5_000 }]],
    ])
    expect(verified.itemOutpoints.get(at('m/9/7'))).toEqual([`${utxo(2).txid}_0`, `${utxo(3).txid}_0`])
    expect([...verified.readAddresses]).toEqual([at('m/7/0'), at('m/9/8')])
    expect(verified.rejected).toBe(3)
  })

  it('reuses the last scan’s addresses instead of deriving, and still rejects a row naming another address', async () => {
    const deriver = makeDeriver()
    const at = (path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()
    const lock = (path: string) => new P2PKH().lock(at(path)).toHex()
    const known = new Map([
      ['m/0/3', at('m/0/3')],
      ['m/9/7', at('m/9/7')],
    ])
    const rows = [
      utxo(1, { path: 'm/0/3', address: at('m/0/3'), script: lock('m/0/3'), satoshis: 5_000 }),
      utxo(2, { path: 'm/9/7', address: at('m/9/7'), script: lock('m/9/7') }),
      utxo(3, { path: 'm/9/7', address: at('m/0/3'), script: lock('m/0/3') }),
      utxo(4, { path: 'm/9/9', address: at('m/9/9'), script: lock('m/9/9') }),
    ]
    const spy = vi.spyOn(deriver, 'privateKeyAt')
    const verified = await verifyUtxoSet(deriver, rows, known)
    expect(spy.mock.calls.map(([path]) => path)).toEqual(['m/9/9'])
    expect(verified.addresses.map((a) => a.path)).toEqual(['m/0/3', 'm/9/7', 'm/9/9'])
    expect(verified.rejected).toBe(1)
  })

  it('routes cosigned MNEE owned by these keys to the MNEE index, and rejects one owned by anyone else', async () => {
    const deriver = makeDeriver()
    const at = (path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()
    const hash = (path: string) => deriver.privateKeyAt(path).toPublicKey().toHash('hex') as string
    const approver = `02${'ab'.repeat(32)}`
    const cosigned = (path: string) => `76a914${hash(path)}88ad21${approver}ac`
    const verified = await verifyUtxoSet(deriver, [
      utxo(1, { path: 'm/7/0', address: at('m/7/0'), script: cosigned('m/7/0'), type: 'instrument' }),
      utxo(2, { path: 'm/7/1', address: at('m/7/1'), script: cosigned('m/7/2'), type: 'instrument' }),
    ])
    expect([...verified.mneeAddresses]).toEqual([at('m/7/0')])
    expect([...verified.readAddresses]).toEqual([])
    expect(verified.addresses.map((a) => a.path)).toEqual(['m/7/0'])
    expect(verified.rejected).toBe(1)
  })
})

describe('readUnspentCash', () => {
  const outputs: CashOutput[] = Array.from({ length: 150 }, (_, i) => {
    const txid = (i + 1).toString(16).padStart(64, '0')
    return { outpoint: `${txid}_0`, txid, vout: 0, satoshis: 5_000 }
  })
  /** txids of a Teranode `/utxos/json` body, in record order. */
  const recordTxids = (body: Uint8Array) =>
    Array.from({ length: body.length / 36 }, (_, r) =>
      Array.from(body.subarray(r * 36, r * 36 + 32))
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    )
  const nth = (txid: string) => parseInt(txid, 16)

  it('places outputs on a node a hundred at a time and asks the explorer only for the rest', async () => {
    resetDiscoveryPacingForTests()
    const explorerAsked: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/utxos/json')) {
        if (url.startsWith('https://mainnet.gorillanode.io')) return new Response('down', { status: 503 })
        // Node: multiples of 3 unknown to it, even spent, odd unspent.
        return new Response(
          JSON.stringify(
            recordTxids(init?.body as Uint8Array).map((txid) =>
              nth(txid) % 3 === 0 ? { errorCode: 'NOT_FOUND' } : nth(txid) % 2 === 0 ? { status: 1, spendingData: { txId: 'ab'.repeat(32) } } : { status: 0 },
            ),
          ),
        )
      }
      expect(url).toBe('https://api.whatsonchain.com/v1/bsv/main/utxos/spent')
      const { utxos } = JSON.parse(String(init?.body)) as { utxos: Array<{ txid: string; vout: number }> }
      explorerAsked.push(...utxos.map((u) => u.txid))
      // Explorer: the first it is asked is unknown to it too; the rest unspent.
      return new Response(JSON.stringify(utxos.map((utxo, i) => (i === 0 && explorerAsked.length <= 20 ? { utxo, error: 'unknown' } : { utxo, spentIn: null }))))
    })
    const read = await readUnspentCash({ chain: 'main', outputs, fetchImpl })
    const nodeCalls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/utxos/json'))
    expect(nodeCalls).toHaveLength(4)
    expect(explorerAsked.map(nth)).toEqual(outputs.map((o) => nth(o.txid)).filter((n) => n % 3 === 0))
    expect(read.unknown).toEqual(new Set([outputs[2].outpoint]))
    const odd = outputs.filter((o) => nth(o.txid) % 3 !== 0 && nth(o.txid) % 2 === 1)
    const thirds = outputs.filter((o) => nth(o.txid) % 3 === 0).slice(1)
    expect(read.unspent).toEqual(new Set([...odd, ...thirds].map((o) => o.outpoint)))
    expect(read.stopped).toBe(false)
  })

  it('leaves everything unknown when no source answers', async () => {
    resetDiscoveryPacingForTests()
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 400 }))
    const pending = readUnspentCash({ chain: 'main', outputs: outputs.slice(0, 5), fetchImpl })
    await vi.runAllTimersAsync()
    const read = await pending
    vi.useRealTimers()
    expect(read.unspent.size).toBe(0)
    expect(read.unknown.size).toBe(5)
  })
})

describe('readUnspentOutpoints', () => {
  const outpoints = Array.from({ length: 150 }, (_, i) => `${(i + 1).toString(16).padStart(64, '0')}_0`)

  it('counts only outpoints the index shows unspent, a hundred per request', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://ordinals.gorillapool.io/api/txos/outpoints?script=false')
      const asked = JSON.parse(String(init?.body)) as string[]
      return new Response(
        JSON.stringify(asked.slice(1).map((outpoint, i) => ({ outpoint, spend: i % 2 ? 'f'.repeat(64) : '' }))),
      )
    })
    const read = await readUnspentOutpoints({ chain: 'main', outpoints, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(read.unspent.size).toBe(50 + 25)
    expect(read.unspent.has(outpoints[0])).toBe(false)
    expect(read).toMatchObject({ failed: 0, stopped: false })
  })

  it('keeps the index facts of each unspent item for browsing', async () => {
    const origin = `${'a'.repeat(64)}_0`
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            outpoint: outpoints[0],
            spend: '',
            origin: {
              outpoint: origin,
              data: {
                map: { app: 'vanitas', name: 'VANITAS #3', type: 'ord' },
                insc: { file: { type: 'image/png', size: 10 } },
              },
            },
          },
          { outpoint: outpoints[1], spend: '', origin: null, data: null },
        ]),
      ),
    )
    const read = await readUnspentOutpoints({ chain: 'main', outpoints: outpoints.slice(0, 2), fetchImpl })
    expect(read.facts.get(outpoints[0])).toEqual({
      origin,
      media: origin,
      name: 'VANITAS #3',
      mimeType: 'image/png',
    })
    expect(read.facts.get(outpoints[1])).toEqual({ origin: null, media: null, name: null, mimeType: null })
  })

  it('retries a chunk once, then counts it as failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 503 }))
    const read = await readUnspentOutpoints({ chain: 'main', outpoints: outpoints.slice(0, 10), fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(read).toMatchObject({ failed: 10 })
    expect(read.unspent.size).toBe(0)
  })
})
