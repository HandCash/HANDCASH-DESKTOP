import { Beef, LockingScript, MerklePath, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_UNKNOWN_RESOLVES_PER_PASS,
  classifyLegacyUtxos,
  fetchRawTxHex,
  peekRawTxHex,
  resolveOneSatInscription,
} from './oneSatImport'
import { PENDING_RETRY_MS, shouldResolveInscription } from './inscriptionCache'
import type { LegacyUtxo } from './legacyScan'
import { buildLatchStateScript } from './oneSatLatch'

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

const ORD_ENVELOPE =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

/** One mined transaction carrying its own merkle proof, as a service returns it. */
function minedBeef(tx: Transaction, height: number): Beef {
  const beef = new Beef()
  const entry = beef.mergeRawTx(tx.toBinary())
  entry.bumpIndex = beef.mergeBump(
    new MerklePath(height, [
      [
        { offset: 0, hash: tx.id('hex'), txid: true },
        { offset: 1, duplicate: true },
      ],
    ]),
  )
  return beef
}

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

describe('classifyLegacyUtxos', () => {
  it('discovers a non-P2PKH hardened tip from its 2-sat Settle beacon', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({ satoshis: 2, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({
      satoshis: 0,
      lockingScript: LockingScript.fromHex(
        buildLatchStateScript({
          schema: 2,
          mode: 'hardened',
          origin: `${TXID_A}_0`,
          tip: 'OUTPUT:0',
          latch: 'OUTPUT:2',
          beacon: 'OUTPUT:1',
          parentLatch: `${TXID_B}_2`,
          proofOutpoint: `${TXID_B}_1`,
          originScriptHash: '12'.repeat(32),
          ownerKeyHash: '34'.repeat(20),
          commitTxid: '56'.repeat(32),
          settleTxid: 'SELF',
          name: 'Hardened item',
        }),
      ),
    })
    const txid = tx.id('hex')
    const fetchMock = vi.fn(async (url: string) =>
      url.includes(`/tx/${txid}/hex`)
        ? new Response(tx.toHex(), { status: 200 })
        : new Response('null', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await classifyLegacyUtxos([utxo(`${txid}.1`, 2)], 'main')

    expect(result.oneSats).toEqual([
      expect.objectContaining({
        outpoint: `${txid}.0`,
        origin: `${TXID_A}_0`,
        name: 'Hardened item',
      }),
    ])
    expect(result.latches.map((u) => u.outpoint)).toEqual([`${txid}.1`])
    vi.unstubAllGlobals()
  })

  it('discovers a hardened BOLT tip through a separate 2-sat beacon transaction', async () => {
    const settle = new Transaction()
    settle.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    settle.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const settleTxid = settle.id('hex')

    const beacon = new Transaction()
    beacon.addOutput({ satoshis: 2, lockingScript: LockingScript.fromHex('51') })
    beacon.addOutput({
      satoshis: 0,
      lockingScript: LockingScript.fromHex(
        buildLatchStateScript({
          schema: 2,
          mode: 'hardened',
          origin: `${TXID_A}_0`,
          tip: `${settleTxid}_0`,
          beacon: 'OUTPUT:0',
          parentLatch: `${TXID_B}_1`,
          proofOutpoint: `${TXID_B}_1`,
          originScriptHash: '12'.repeat(32),
          ownerKeyHash: '34'.repeat(20),
          commitTxid: '56'.repeat(32),
          settleTxid,
        }),
      ),
    })
    const beaconTxid = beacon.id('hex')
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(`/tx/${beaconTxid}/hex`)) {
        return new Response(beacon.toHex(), { status: 200 })
      }
      if (url.includes(`/tx/${settleTxid}/hex`)) {
        return new Response(settle.toHex(), { status: 200 })
      }
      return new Response('null', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await classifyLegacyUtxos([utxo(`${beaconTxid}.0`, 2)], 'main')

    expect(result.oneSats).toEqual([
      expect.objectContaining({
        outpoint: `${settleTxid}.0`,
        origin: `${TXID_A}_0`,
      }),
    ])
    expect(result.latches.map((u) => u.outpoint)).toEqual([`${beaconTxid}.0`])
    vi.unstubAllGlobals()
  })

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

  it('retries a latch-proven tip on the pending window, not on every poll', async () => {
    // BRC-156 pays tip at OUTPUT:0 and a 2-sat latch at OUTPUT:1. The latch is
    // local proof an item landed, so the ten-minute dust backoff would keep a
    // real transfer invisible. Retrying on every poll is the opposite failure:
    // the poll drops to 8s while a tip is pending and each walk costs a request
    // per input per hop, so the wallet throttles itself out of ever resolving.
    const TXID_D = 'd'.repeat(64)
    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const start = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(start)

    const scan = [utxo(`${TXID_D}.0`, 1), utxo(`${TXID_D}.1`, 2)]

    const first = await classifyLegacyUtxos(scan, 'main')
    expect(first.latches.map((u) => u.outpoint)).toEqual([`${TXID_D}.1`])
    expect(first.pendingTips.map((u) => u.outpoint)).toEqual([`${TXID_D}.0`])

    fetchMock.mockClear()
    const second = await classifyLegacyUtxos(scan, 'main')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(second.pendingTips.map((u) => u.outpoint)).toEqual([`${TXID_D}.0`])

    // Still well inside the ten-minute stray-dust backoff.
    vi.setSystemTime(start + PENDING_RETRY_MS + 1_000)
    fetchMock.mockClear()
    const third = await classifyLegacyUtxos(scan, 'main')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(third.pendingTips.map((u) => u.outpoint)).toEqual([`${TXID_D}.0`])

    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('proves a latched tip from the chain when no indexer can name it', async () => {
    // The failure this covers looks like a lost transfer: a latch says the item
    // landed, but every indexer answers nothing — because it is behind, or simply
    // unreachable — so ingest held the tip out of Collectables on an 8s loop
    // forever. Its ancestry is chain data, so the wallet can settle the origin
    // itself and let name/traits arrive later.
    const genesis = new Transaction()
    genesis.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: genesis,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tip.addOutput({ satoshis: 2, lockingScript: LockingScript.fromHex('51') })
    const tipId = tip.id('hex')

    const fetchMock = vi.fn(async () => new Response('null', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const heights = new Map([
      [genesis.id('hex'), 900_000],
      [tipId, 900_001],
    ])
    activeWallet = {
      services: {
        getBeefForTxid: vi.fn(async (txid: string) => {
          const height = heights.get(txid)
          if (height == null) throw new Error(`no such transaction ${txid}`)
          return minedBeef(txid === tipId ? tip : genesis, height)
        }),
      },
    }

    const result = await classifyLegacyUtxos(
      [utxo(`${tipId}.0`, 1), utxo(`${tipId}.1`, 2)],
      'main',
    )

    expect(result.pendingTips).toEqual([])
    expect(result.oneSats).toEqual([
      expect.objectContaining({
        outpoint: `${tipId}.0`,
        origin: `${genesis.id('hex')}_0`,
      }),
    ])
    activeWallet = null
    vi.unstubAllGlobals()
  })

  it('fundingOnly classifies funds without any indexer call', async () => {
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
    expect(result.latches.map((u) => u.outpoint)).toEqual([`${TXID_F}.1`])
    expect(result.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_F}.0`])
    expect(result.oneSats).toEqual([])
    vi.unstubAllGlobals()
  })

  it('never treats the latch itself as a tip or as funds', async () => {
    const TXID_E = 'e'.repeat(64)
    const result = await classifyLegacyUtxos([utxo(`${TXID_E}.1`, 2)], 'main')

    expect(result.funding).toEqual([])
    expect(result.oneSats).toEqual([])
    expect(result.pendingTips).toEqual([])
    expect(result.latches.map((u) => u.outpoint)).toEqual([`${TXID_E}.1`])
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

  it('never sweeps soft-latch dust as funding', async () => {
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
    expect(result.latches.map((u) => u.outpoint)).toEqual([`${TXID}.1`])
    expect(result.funding).toEqual([])
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
          map: { name: 'Pixel Foxes #2437906', app: 'Bubblemint' },
          insc: { file: { type: 'image/png' } },
        },
      },
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
