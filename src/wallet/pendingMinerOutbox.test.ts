import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

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
    store.set(key, value)
  },
}))

const recordTransactionStage = vi.fn()
vi.mock('./transactionTelemetry', () => ({
  activeTransactionTrace: () => ({
    traceId: 'trace-test',
    requestId: 'request-test',
    flow: 'brc29',
  }),
  recordTransactionStage: (...args: unknown[]) => recordTransactionStage(...args),
}))

beforeEach(() => {
  store.clear()
  recordTransactionStage.mockClear()
})

describe('pending miner outbox', () => {
  it('persists Atomic BEEF before provider submission and deduplicates by txid', async () => {
    const { enqueuePendingMinerSubmit, pendingMinerOutboxDepth } = await import(
      './pendingMinerOutbox'
    )
    const tx = signedTx(1_000)
    const txid = tx.id('hex')
    const atomic = atomicBeefFor(tx)
    expect(enqueuePendingMinerSubmit(txid, atomic)).toBe(true)
    expect(enqueuePendingMinerSubmit(txid, atomic)).toBe(true)
    expect(pendingMinerOutboxDepth()).toBe(1)

    const rows = JSON.parse(
      store.get('handcash.wallet.pendingMinerOutbox.v1') || '[]',
    ) as Array<{ atomic: number[]; traceId?: string }>
    expect(rows[0]?.atomic).toEqual(atomic)
    expect(rows[0]?.traceId).toBe('trace-test')
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
      'handcash.wallet.pendingMinerOutbox.v1',
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
      JSON.parse(store.get('handcash.wallet.pendingMinerOutbox.v1') || '[]'),
    ).toEqual([])
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
      store.get('handcash.wallet.pendingMinerOutbox.v1') || '[]',
    ) as Array<{ atomic: number[] }>
    expect(rows[0]?.atomic).toEqual(mergedAtomic)
    expect(
      Beef.fromBinary(rows[0]!.atomic).findTxid(parent.id('hex'))?.isTxidOnly,
    ).toBeFalsy()

    // An unknown txid must not silently create a row.
    expect(updatePendingMinerSubmitBody('cd'.repeat(32), mergedAtomic)).toBe(false)
  })
})
