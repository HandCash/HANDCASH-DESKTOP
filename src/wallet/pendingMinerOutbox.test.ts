import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
let writesSucceed = true
const KEY = 'handcash.wallet.pendingMinerOutbox.v1'

function signedTx(satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: LockingScript.fromHex('51') })
  return tx
}

/** AtomicBEEF carrying the subject body — what a real send queues. */
function atomicBeefFor(tx: Transaction): number[] {
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef.toBinaryAtomic(tx.id('hex'))
}

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (!writesSucceed) return false
    store.set(key, value)
    return true
  },
}))

const recordTransactionStage = vi.fn()
const submitAtomicBeefToMiners = vi.fn(async () => ({
  kind: 'queued' as const,
  reason: 'no-ack' as const,
}))
vi.mock('./transactionTelemetry', () => ({
  activeTransactionTrace: () => ({
    traceId: 'trace-test',
    requestId: 'request-test',
    flow: 'brc29',
  }),
  recordTransactionStage: (...args: unknown[]) => recordTransactionStage(...args),
}))

vi.mock('./minerSubmit', () => ({
  submitAtomicBeefToMiners: (...args: unknown[]) =>
    submitAtomicBeefToMiners(...args),
  minerSubmitKeepOutbox: (result: { kind: string; keepPropagating?: boolean }) =>
    result.kind !== 'accepted' || result.keepPropagating === true,
  reportLateMinerSubmitFailure: vi.fn(async () => undefined),
}))

beforeEach(() => {
  store.clear()
  writesSucceed = true
  recordTransactionStage.mockClear()
  submitAtomicBeefToMiners.mockClear()
})

describe('pending miner outbox', () => {
  it('persists Atomic BEEF before provider submission and deduplicates by txid', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    const tx = signedTx(1_000)
    const txid = tx.id('hex')
    const atomic = atomicBeefFor(tx)
    expect(
      enqueuePendingMinerSubmit(txid, atomic, { flow: 'token_transfer' }),
    ).toBe(true)
    expect(enqueuePendingMinerSubmit(txid, atomic)).toBe(true)
    expect(pendingMinerOutboxDepth()).toBe(1)

    const rows = JSON.parse(
      store.get(KEY) || '[]',
    ) as Array<{ atomic: number[]; traceId?: string; flow?: string }>
    expect(rows[0]?.atomic).toEqual(atomic)
    expect(rows[0]?.traceId).toBe('trace-test')
    expect(rows[0]?.flow).toBe('token_transfer')
    expect(recordTransactionStage).toHaveBeenCalledWith(
      'propagation_queued',
      expect.objectContaining({ txid }),
    )
  })

  it('rejects invalid transaction bodies without persistence', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    expect(enqueuePendingMinerSubmit('bad', [1])).toBe(false)
    expect(enqueuePendingMinerSubmit('ab'.repeat(32), [256])).toBe(false)
    expect(pendingMinerOutboxDepth()).toBe(0)
  })

  it('refuses to store bytes that are not a BEEF carrying the subject body', async () => {
    const {
      classifyPendingMinerBody,
      enqueuePendingMinerSubmit,
      pendingMinerOutboxDepth,
    } = await import('./pendingMinerOutbox')
    // Retrying these for hours can never make them valid; they only keep the
    // send looking in-flight.
    expect(classifyPendingMinerBody('ab'.repeat(32), [1, 2, 3])).toEqual({
      kind: 'refuse',
      reason: 'malformed-beef',
    })
    expect(enqueuePendingMinerSubmit('ab'.repeat(32), [1, 2, 3])).toBe(false)

    const tx = signedTx(1_000)
    const stub = new Beef()
    stub.mergeTxidOnly(tx.id('hex'))
    expect(classifyPendingMinerBody(tx.id('hex'), stub.toBinary())).toEqual({
      kind: 'refuse',
      reason: 'subject-body-missing',
    })
    expect(enqueuePendingMinerSubmit(tx.id('hex'), stub.toBinary())).toBe(false)

    const other = signedTx(2_000)
    expect(
      enqueuePendingMinerSubmit(tx.id('hex'), atomicBeefFor(other)),
    ).toBe(false)

    expect(pendingMinerOutboxDepth()).toBe(0)
  })

  it('removes invalid rows persisted by older byte-range-only builds', async () => {
    store.set(
      KEY,
      JSON.stringify([
        {
          txid: 'ab'.repeat(32),
          atomic: [1, 2, 3],
          createdAt: 1,
          attempts: 0,
          nextAttemptAt: 1,
        },
      ]),
    )
    const { pendingMinerOutboxDepth } = await import('./pendingMinerOutbox')
    expect(pendingMinerOutboxDepth()).toBe(0)
    expect(
      JSON.parse(store.get(KEY) || '[]'),
    ).toEqual([])
  })

  it('never evicts an older live cheque to enforce a row cap', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    for (let sats = 1; sats <= 30; sats += 1) {
      const tx = signedTx(sats)
      expect(enqueuePendingMinerSubmit(tx.id('hex'), atomicBeefFor(tx))).toBe(true)
    }
    expect(pendingMinerOutboxDepth()).toBe(30)
  })

  it('reports a durable write failure instead of claiming the cheque is queued', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    const tx = signedTx(1_000)
    writesSucceed = false
    expect(enqueuePendingMinerSubmit(tx.id('hex'), atomicBeefFor(tx))).toBe(false)
    expect(pendingMinerOutboxDepth()).toBe(0)
  })

  it('keeps retrying a live cheque beyond the old forty-attempt cutoff', async () => {
    const {
      enqueuePendingMinerSubmit,
      flushPendingMinerOutbox,
      pendingMinerOutboxDepth,
    } = await import('./pendingMinerOutbox')
    const tx = signedTx(2_000)
    expect(enqueuePendingMinerSubmit(tx.id('hex'), atomicBeefFor(tx))).toBe(true)

    for (let attempt = 0; attempt < 45; attempt += 1) {
      const rows = JSON.parse(
        store.get(KEY) || '[]',
      ) as Array<{ nextAttemptAt: number }>
      rows[0]!.nextAttemptAt = 0
      store.set(KEY, JSON.stringify(rows))
      await flushPendingMinerOutbox()
    }

    expect(pendingMinerOutboxDepth()).toBe(1)
    expect(submitAtomicBeefToMiners).toHaveBeenCalledTimes(45)
  })

  it('upgrades a queued body once ancestry has been merged in', async () => {
    const {
      classifyPendingMinerBody,
      enqueuePendingMinerSubmit,
      updatePendingMinerSubmitBody,
    } = await import('./pendingMinerOutbox')

    const parent = signedTx(10_000)
    const tip = new Transaction()
    tip.addInput({
      sourceTXID: parent.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: LockingScript.fromHex('51'),
    })
    tip.addOutput({ satoshis: 9_900, lockingScript: LockingScript.fromHex('51') })
    const txid = tip.id('hex')

    const thin = new Beef()
    thin.mergeTxidOnly(parent.id('hex'))
    thin.mergeTransaction(tip)
    const thinAtomic = thin.toBinaryAtomic(txid)
    expect(classifyPendingMinerBody(txid, thinAtomic)).toEqual({
      kind: 'recoverable-ancestry',
    })
    expect(enqueuePendingMinerSubmit(txid, thinAtomic)).toBe(true)

    const merged = new Beef()
    merged.mergeRawTx(parent.toBinary())
    merged.mergeTransaction(tip)
    const mergedAtomic = merged.toBinaryAtomic(txid)
    expect(classifyPendingMinerBody(txid, mergedAtomic)).toEqual({
      kind: 'spv-ready',
    })
    expect(updatePendingMinerSubmitBody(txid, mergedAtomic)).toBe(true)

    const rows = JSON.parse(
      store.get(KEY) || '[]',
    ) as Array<{ atomic: number[] }>
    expect(rows[0]?.atomic).toEqual(mergedAtomic)
    expect(
      Beef.fromBinary(rows[0]!.atomic).findTxid(parent.id('hex'))?.isTxidOnly,
    ).toBeFalsy()

    // An unknown txid must not silently create a row.
    expect(updatePendingMinerSubmitBody('cd'.repeat(32), mergedAtomic)).toBe(false)
  })
})
