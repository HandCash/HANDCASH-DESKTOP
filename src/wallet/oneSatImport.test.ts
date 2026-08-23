import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_UNKNOWN_RESOLVES_PER_PASS,
  classifyLegacyUtxos,
  fetchRawTxHex,
  peekRawTxHex,
  resolveInscriptionPreferringOrigin,
  resolveOneSatInscription,
} from './oneSatImport'
import { shouldResolveInscription } from './inscriptionCache'
import type { LegacyUtxo } from './legacyScan'

function utxo(outpoint: string, satoshis: number): LegacyUtxo {
  const [txid, vout] = outpoint.split('.')
  return { outpoint, txid: txid!, vout: Number(vout), satoshis }
}

/** Session wallet seen by the code under test; set per test that needs BEEF. */
let activeWallet: unknown = null
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  getActiveWallet: () => activeWallet,
}))

const announceItemsReceived = vi.fn()
vi.mock('./itemArrivalToast', () => ({
  announceItemsReceived: (...args: unknown[]) => announceItemsReceived(...args),
  announceItemVerified: vi.fn(),
}))

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

describe('classifyLegacyUtxos', () => {
  it('sweeps a cloud-named outpoint that actually holds funds', async () => {
    // Basket `1sat` is excluded from spendable balance, so a mis-reported item
    // would silently remove real money from the wallet.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A}.0`, 50_000)],
      'main',
      [{ outpoint: `${TXID_A}.0`, origin: `${TXID_A}_0` }],
    )
    warn.mockRestore()

    expect(result.oneSats).toEqual([])
    expect(result.funding.map((u) => u.outpoint)).toEqual([`${TXID_A}.0`])
  })

  it('asks GorillaPool once for an unverifiable tip, then backs off', async () => {
    // Only unverified tips hit the indexer. Classification runs on every poll —
    // re-walking the same dust is what froze the UI, so misses are remembered.
    const TXID_C = 'c'.repeat(64)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await classifyLegacyUtxos([utxo(`${TXID_C}.0`, 1)], 'main')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(first.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_C}.0`])

    fetchMock.mockClear()
    const second = await classifyLegacyUtxos([utxo(`${TXID_C}.0`, 1)], 'main')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(second.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_C}.0`])
    vi.unstubAllGlobals()
  })

  it('counts held tips still awaiting indexer identity as pendingTips', async () => {
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const tips = Array.from(
      { length: MAX_UNKNOWN_RESOLVES_PER_PASS + 2 },
      (_, i) => utxo(`${String(i).padStart(64, 'a')}.0`, 1),
    )
    const result = await classifyLegacyUtxos(tips, 'main')

    expect(result.heldOneSats.length).toBe(tips.length)
    expect(result.pendingTips.length).toBe(2)
    expect(result.pendingTips.map((u) => u.outpoint)).toEqual(
      tips.slice(MAX_UNKNOWN_RESOLVES_PER_PASS).map((u) => u.outpoint),
    )
    vi.unstubAllGlobals()
  })

  it('holds a 404 tip then backs off on the next poll', async () => {
    const TXID_D = 'd'.repeat(64)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const scan = [utxo(`${TXID_D}.0`, 1)]
    const first = await classifyLegacyUtxos(scan, 'main')

    expect(first.pendingTips).toEqual([])
    expect(first.oneSats).toEqual([])
    expect(first.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_D}.0`])

    // Backoff: do not re-hammer the network on the next poll for the same tip.
    fetchMock.mockClear()
    const second = await classifyLegacyUtxos(scan, 'main')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(second.oneSats).toEqual([])
    expect(second.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_D}.0`])
    expect(second.pendingTips).toEqual([])

    vi.unstubAllGlobals()
  })

  it('fundingOnly sweeps 2-sat outs as funds without any indexer call', async () => {
    // The pre-send heal runs this. A payment cannot spend a tip, so naming one
    // is pure latency on the path where the user is waiting to send.
    const TXID_F = 'f'.repeat(64)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_F}.0`, 1), utxo(`${TXID_F}.1`, 2), utxo(`${TXID_F}.2`, 50_000)],
      'main',
      [],
      { fundingOnly: true },
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.funding.map((u) => u.outpoint)).toEqual([`${TXID_F}.2`])
    expect(result.heldUneconomical.map((u) => u.outpoint)).toEqual([`${TXID_F}.1`])
    expect(result.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_F}.0`])
    expect(result.oneSats).toEqual([])
    vi.unstubAllGlobals()
  })

  it('holds a 2-sat companion as uneconomical — never funding', async () => {
    const TXID_E = 'e'.repeat(64)
    const result = await classifyLegacyUtxos([utxo(`${TXID_E}.1`, 2)], 'main')

    expect(result.oneSats).toEqual([])
    expect(result.pendingTips).toEqual([])
    expect(result.funding).toEqual([])
    expect(result.heldUneconomical.map((u) => u.outpoint)).toEqual([`${TXID_E}.1`])
  })

  const P2PKH_HEX = '76a914' + '11'.repeat(20) + '88ac'
  /** `OP_FALSE OP_IF "ord" OP_1 <text/plain> OP_0 <hi> OP_ENDIF` */
  const ORD_ENVELOPE =
    '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

  function buildTx(
    outputs: { scriptHex: string; satoshis: number }[],
    inputs: { txid: string; vout: number }[] = [],
  ): Transaction {
    const tx = new Transaction()
    for (const i of inputs) {
      tx.addInput({
        sourceTXID: i.txid,
        sourceOutputIndex: i.vout,
        unlockingScript: new UnlockingScript([]),
        sequence: 0xffffffff,
      })
    }
    for (const o of outputs) {
      tx.addOutput({
        lockingScript: LockingScript.fromHex(o.scriptHex),
        satoshis: o.satoshis,
      })
    }
    return tx
  }

  /** Serve raw tx bodies through the toolbox provider path, like a live wallet. */
  function serveRawTxs(...txs: Transaction[]): void {
    const byTxid = new Map(txs.map((tx) => [tx.id('hex'), tx.toBinary()]))
    activeWallet = {
      chain: 'main',
      services: {
        getRawTx: async (txid: string) => ({ rawTx: byTxid.get(txid) ?? null }),
      },
    }
  }

  it('paints a bare tip instantly when its tx spends a 1-sat input — no indexer', async () => {
    // Instant ingest, deferred verify: this is the BRC-150 replacement for the
    // latch fast path. Discovery is the transfer shape (spends an existing
    // 1-sat tip); the real origin/name settle after paint.
    const parent = buildTx([{ scriptHex: P2PKH_HEX, satoshis: 1 }])
    const transfer = buildTx(
      [{ scriptHex: P2PKH_HEX, satoshis: 1 }],
      [{ txid: parent.id('hex'), vout: 0 }],
    )
    serveRawTxs(parent, transfer)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const tipOutpoint = `${transfer.id('hex')}.0`
    const result = await classifyLegacyUtxos([utxo(tipOutpoint, 1)], 'main')

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([tipOutpoint])
    expect(result.oneSats[0]!.origin).toBe(`${transfer.id('hex')}_0`)
    expect(result.heldOneSats).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()

    activeWallet = null
    vi.unstubAllGlobals()
  })

  it('paints an inscribed mint instantly from its own envelope — no indexer', async () => {
    const funding = buildTx([{ scriptHex: P2PKH_HEX, satoshis: 10_000 }])
    const mint = buildTx(
      [{ scriptHex: ORD_ENVELOPE + P2PKH_HEX, satoshis: 1 }],
      [{ txid: funding.id('hex'), vout: 0 }],
    )
    serveRawTxs(funding, mint)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const tipOutpoint = `${mint.id('hex')}.0`
    const result = await classifyLegacyUtxos([utxo(tipOutpoint, 1)], 'main')

    // Tip-as-origin is literally correct for a mint.
    expect(result.oneSats.map((i) => i.origin)).toEqual([`${mint.id('hex')}_0`])
    expect(fetchMock).not.toHaveBeenCalled()

    activeWallet = null
    vi.unstubAllGlobals()
  })

  it('never blind-paints a BSV-21 envelope tip as an NFT', async () => {
    // A fungible misfiled into basket `1sat` corrupts token accounting, so a
    // bsv-20 mime must fall through to the indexer instead of the fast path.
    const mimeHex = Array.from(new TextEncoder().encode('application/bsv-20'))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const bsv21Envelope = '0063036f726451' + '12' + mimeHex + '0002' + '7b7d' + '68'
    const funding = buildTx([{ scriptHex: P2PKH_HEX, satoshis: 10_000 }])
    const mint = buildTx(
      [{ scriptHex: bsv21Envelope + P2PKH_HEX, satoshis: 1 }],
      [{ txid: funding.id('hex'), vout: 0 }],
    )
    serveRawTxs(funding, mint)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const tipOutpoint = `${mint.id('hex')}.0`
    const result = await classifyLegacyUtxos([utxo(tipOutpoint, 1)], 'main')

    expect(result.oneSats).toEqual([])
    expect(result.heldOneSats.map((u) => u.outpoint)).toEqual([tipOutpoint])
    // It asked the indexer (and missed) rather than painting blind.
    expect(fetchMock).toHaveBeenCalled()

    activeWallet = null
    vi.unstubAllGlobals()
  })

  it('keeps a cloud-named outpoint that really is one satoshi', async () => {
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A}.0`, 1)],
      'main',
      [{ outpoint: `${TXID_A}.0`, origin: `${TXID_A}_0` }],
    )

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([`${TXID_A}.0`])
    expect(result.funding).toEqual([])
  })

  it('matches cloud items against the scan regardless of outpoint casing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A.toUpperCase()}.0`, 50_000)],
      'main',
      [{ outpoint: `${TXID_A}.0` }],
    )
    warn.mockRestore()

    expect(result.oneSats).toEqual([])
    expect(result.funding).toHaveLength(1)
  })

  it('still trusts cloud items that are not in the legacy scan', async () => {
    // These live on the migrate destination tx, not the legacy address.
    const result = await classifyLegacyUtxos([], 'main', [
      { outpoint: `${TXID_B}.1`, origin: `${TXID_B}_1` },
    ])

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([`${TXID_B}.1`])
  })

  it('holds a 2-sat companion while keeping a cloud-named 1-sat as an item', async () => {
    const TXID = 'c'.repeat(64)
    const result = await classifyLegacyUtxos(
      [
        { outpoint: `${TXID}.0`, txid: TXID, vout: 0, satoshis: 1 },
        { outpoint: `${TXID}.1`, txid: TXID, vout: 1, satoshis: 2 },
      ],
      'main',
      [{ outpoint: `${TXID}.0`, origin: `${TXID}_0` }],
    )

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([`${TXID}.0`])
    expect(result.funding).toEqual([])
    expect(result.heldUneconomical.map((u) => u.outpoint)).toEqual([`${TXID}.1`])
  })

  it('never sweeps unresolvable one-sat outputs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const result = await classifyLegacyUtxos([utxo(`${TXID_B}.0`, 1)], 'main', [])
    vi.unstubAllGlobals()

    expect(result.funding).toEqual([])
    expect(result.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_B}.0`])
  })

  it('identifies a bounded number of unknown outputs per pass, holding the rest', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `${'0'.repeat(63)}${i + 1}`)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const result = await classifyLegacyUtxos(
      ids.map((id) => utxo(`${id}.0`, 1)),
      'main',
      [],
    )
    vi.unstubAllGlobals()

    expect(result.heldOneSats).toHaveLength(9)
    // A walked output is backed off; an unbudgeted one is untouched so the next
    // pass picks it up instead of it being written off as unresolvable.
    const walked = ids.filter((id) => !shouldResolveInscription(`${id}.0`))
    expect(walked).toHaveLength(MAX_UNKNOWN_RESOLVES_PER_PASS)
  })
})

describe('resolveOneSatInscription', () => {
  const TIP = 'c'.repeat(64)
  const ORIGIN = 'd'.repeat(64)

  const bareTxo = (outpoint: string) =>
    JSON.stringify({ outpoint, satoshis: 1, origin: { outpoint }, data: null })

  const inscribedTxo = (outpoint: string) =>
    JSON.stringify({
      outpoint,
      origin: {
        outpoint,
        data: {
          map: {
            name: 'Pixel Foxes #2437906',
            app: 'Bubblemint',
            subTypeData: {
              traits: [{ name: 'fox', value: 'Arctic Fox' }],
            },
          },
          insc: { file: { type: 'image/png' } },
        },
      },
    })

  it('asks a known origin before walking an unindexed tip', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(`/api/txos/${TIP}_0`) || url.includes(`/api/inscriptions/${TIP}_0`)) {
        return new Response('{"message":"Not Found"}', { status: 404 })
      }
      if (url.includes(`/api/txos/${ORIGIN}_33`) || url.includes(`/api/inscriptions/${ORIGIN}_33`)) {
        return new Response(inscribedTxo(`${ORIGIN}_33`), { status: 200 })
      }
      return new Response('null', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolved = await resolveInscriptionPreferringOrigin(
      `${TIP}.0`,
      'main',
      `${ORIGIN}_33`,
    )
    vi.unstubAllGlobals()

    expect(resolved?.name).toBe('Pixel Foxes #2437906')
    expect(resolved?.traits).toEqual([{ name: 'fox', value: 'Arctic Fox' }])
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(TIP))).toBe(false)
  })

  it('walks past a satoshi the indexer only knows as its own origin', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(`/api/txos/${TIP}_0`)) {
        return new Response(bareTxo(`${TIP}_0`), { status: 200 })
      }
      if (url.includes(`/tx/${TIP}`)) {
        return new Response(JSON.stringify({ vin: [{ txid: ORIGIN, vout: 7 }] }), {
          status: 200,
        })
      }
      if (url.includes(`/api/txos/${ORIGIN}_7`)) {
        return new Response(inscribedTxo(`${ORIGIN}_7`), { status: 200 })
      }
      return new Response('null', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolved = await resolveOneSatInscription(TIP, 0, 'main', 2)
    vi.unstubAllGlobals()

    expect(resolved?.origin).toBe(`${ORIGIN}_7`)
    expect(resolved?.name).toBe('Pixel Foxes #2437906')
    expect(resolved?.mimeType).toBe('image/png')
  })
})

describe('fetchRawTxHex', () => {
  it('fetches a body once and serves every later ladder step from cache', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    const fetchMock = vi.fn(async () => new Response(tx.toHex(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([
      fetchRawTxHex(txid, 'main'),
      fetchRawTxHex(txid, 'main'),
    ])
    const third = await fetchRawTxHex(txid, 'main')
    vi.unstubAllGlobals()

    expect(first).toBe(tx.toHex())
    expect(second).toBe(tx.toHex())
    expect(third).toBe(tx.toHex())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(peekRawTxHex(txid)).toBe(tx.toHex())
  })

  it('reports no cached body for a transaction it has never fetched', () => {
    expect(peekRawTxHex('f'.repeat(64))).toBeNull()
  })
})
