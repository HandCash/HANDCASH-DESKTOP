import { createActor } from 'xstate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

import { arcStatusFromPostBeef, handleArcRejection, parseArcStatus } from './arcStatusMap'
import {
  beginDualLayerSend,
  failDualLayerSend,
  noteDualLayerPostBeef,
  noteDualLayerTxid,
} from './dualLayerSend'
import { validateBeforeOptimisticLock } from './protocolValidate'
import {
  canTransitionTx,
  txStatusFromArc,
  type TxStatus,
} from './txLifecycle'
import { txLifecycleMachine } from './txLifecycleMachine'
import { __resetTxStoreForTests, getTxRecord, markTxMined } from './txStore'
import {
  __resetUtxoLocksForTests,
  confirmSpentLocks,
  listUtxoLocks,
  optimisticSpendableSats,
  rollbackLocks,
  softLockInputs,
  softLockedSatsTotal,
} from './utxoLockManager'
import { canTransitionUtxo } from './utxoLifecycle'

describe('txLifecycle transitions', () => {
  it('allows DRAFT → VALIDATING → BROADCASTING → SEEN_IN_MEMPOOL → MINED', () => {
    const path: TxStatus[] = [
      'DRAFT',
      'VALIDATING',
      'BROADCASTING',
      'SEEN_IN_MEMPOOL',
      'MINED',
    ]
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionTx(path[i]!, path[i + 1]!)).toBe(true)
    }
  })

  it('forbids MINED → SEEN_IN_MEMPOOL (must go via REORG_ORPHANED)', () => {
    expect(canTransitionTx('MINED', 'SEEN_IN_MEMPOOL')).toBe(false)
    expect(canTransitionTx('MINED', 'REORG_ORPHANED')).toBe(true)
  })

  it('maps ARC MINED to SEEN_IN_MEMPOOL (not hard finality)', () => {
    expect(txStatusFromArc('MINED')).toBe('SEEN_IN_MEMPOOL')
    expect(txStatusFromArc('SEEN_ON_NETWORK')).toBe('SEEN_IN_MEMPOOL')
    expect(txStatusFromArc('DOUBLE_SPEND_ATTEMPTED')).toBe('FAILED_REJECTED')
  })
})

describe('utxoLifecycle transitions', () => {
  it('soft-lock → unspent / spent / frozen', () => {
    expect(canTransitionUtxo('UNSPENT', 'SOFT_LOCKED_PENDING')).toBe(true)
    expect(canTransitionUtxo('SOFT_LOCKED_PENDING', 'UNSPENT')).toBe(true)
    expect(canTransitionUtxo('SOFT_LOCKED_PENDING', 'SPENT_CONFIRMED')).toBe(true)
    expect(canTransitionUtxo('SPENT_CONFIRMED', 'UNSPENT')).toBe(false)
  })
})

describe('protocolValidate', () => {
  it('rejects non-integer sats without mutating anything', () => {
    const r = validateBeforeOptimisticLock({
      satoshis: 1.5,
      availableSats: 1000,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_SATOSHIS')
  })

  it('rejects insufficient funds', () => {
    const r = validateBeforeOptimisticLock({
      satoshis: 500,
      availableSats: 400,
      feeSats: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('accepts valid integer payment', () => {
    expect(
      validateBeforeOptimisticLock({
        satoshis: 100,
        availableSats: 200,
      }).ok,
    ).toBe(true)
  })
})

describe('arcStatusMap', () => {
  it('parses ARC codes', () => {
    expect(parseArcStatus('SEEN_ON_NETWORK')).toBe('SEEN_ON_NETWORK')
    expect(parseArcStatus('double-spend-attempted')).toBe('DOUBLE_SPEND_ATTEMPTED')
  })

  it('maps postBeef accept to SEEN_ON_NETWORK never MINED', () => {
    expect(
      arcStatusFromPostBeef({
        accepted: true,
        doubleSpend: false,
        missingInputs: false,
        serviceOnlyErrors: false,
        detail: 'ok',
        competingTxs: [],
      }),
    ).toBe('SEEN_ON_NETWORK')
  })

  it('double-spend policy rolls back + releases stale', () => {
    const h = handleArcRejection('DOUBLE_SPEND_ATTEMPTED')
    expect(h.shouldRollbackLocks).toBe(true)
    expect(h.shouldReleaseStaleOutputs).toBe(true)
  })
})

describe('utxoLockManager + dualLayerSend', () => {
  beforeEach(() => {
    store.clear()
    __resetTxStoreForTests()
    __resetUtxoLocksForTests()
  })

  it('soft-locks deduct optimistic balance and roll back on fail', () => {
    const locked = softLockInputs({
      lockOwnerId: 'tx-1',
      inputs: [{ outpoint: 'aa'.repeat(32) + '_0', satoshis: 250 }],
    })
    expect(locked.ok).toBe(true)
    expect(softLockedSatsTotal()).toBe(250)
    expect(optimisticSpendableSats(1000)).toBe(750)

    expect(rollbackLocks('tx-1')).toBe(1)
    expect(softLockedSatsTotal()).toBe(0)
    expect(listUtxoLocks()[0]?.status).toBe('UNSPENT')
  })

  it('beginDualLayerSend validates before lock and fails closed', () => {
    const bad = beginDualLayerSend({
      satoshis: 0,
      availableSats: 1000,
      to: '1Abc',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.code).toBe('INVALID_SATOSHIS')
      expect(getTxRecord(bad.record!.id)?.status).toBe('FAILED_REJECTED')
    }
  })

  it('happy path: broadcast → mempool → mined confirms locks', () => {
    const start = beginDualLayerSend({
      satoshis: 100,
      availableSats: 500,
      to: '1Abc',
      inputs: [{ outpoint: 'bb'.repeat(32) + '_1', satoshis: 100 }],
    })
    expect(start.ok).toBe(true)
    if (!start.ok) return

    const id = start.record.id
    expect(start.record.status).toBe('BROADCASTING')
    expect(softLockedSatsTotal()).toBe(100)

    const txid = 'cc'.repeat(32)
    noteDualLayerTxid(id, txid)
    noteDualLayerPostBeef(id, {
      accepted: true,
      doubleSpend: false,
      missingInputs: false,
      serviceOnlyErrors: false,
      detail: 'ok',
      competingTxs: [],
    })
    expect(getTxRecord(id)?.status).toBe('SEEN_IN_MEMPOOL')

    markTxMined(id, 900_000)
    confirmSpentLocks(id)
    expect(getTxRecord(id)?.status).toBe('MINED')
    expect(listUtxoLocks().find((l) => l.lockOwnerId === id)?.status).toBe(
      'SPENT_CONFIRMED',
    )
  })

  it('postBeef double-spend fails and rolls locks', () => {
    const start = beginDualLayerSend({
      satoshis: 50,
      availableSats: 500,
      inputs: [{ outpoint: 'dd'.repeat(32) + '_0', satoshis: 50 }],
    })
    expect(start.ok).toBe(true)
    if (!start.ok) return

    noteDualLayerPostBeef(start.record.id, {
      accepted: false,
      doubleSpend: true,
      missingInputs: true,
      serviceOnlyErrors: false,
      detail: 'MissingInputs',
      competingTxs: [],
    })
    expect(getTxRecord(start.record.id)?.status).toBe('FAILED_REJECTED')
    expect(softLockedSatsTotal()).toBe(0)
  })

  it('failDualLayerSend rolls back', () => {
    const start = beginDualLayerSend({
      satoshis: 10,
      availableSats: 100,
      inputs: [{ outpoint: 'ee'.repeat(32) + '_0', satoshis: 10 }],
    })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    failDualLayerSend(start.record.id, 'ARC_REJECTED', 'nope')
    expect(softLockedSatsTotal()).toBe(0)
  })
})

describe('txLifecycleMachine', () => {
  it('draft → validating → broadcasting → mempool → mined', () => {
    const actor = createActor(txLifecycleMachine).start()
    actor.send({ type: 'START', id: 't1' })
    expect(actor.getSnapshot().matches('draft')).toBe(true)
    actor.send({ type: 'VALIDATED' })
    actor.send({ type: 'DISPATCH' })
    expect(actor.getSnapshot().matches('broadcasting')).toBe(true)
    actor.send({ type: 'ARC', status: 'SEEN_ON_NETWORK' })
    expect(actor.getSnapshot().matches('seenInMempool')).toBe(true)
    actor.send({ type: 'BUMP_VERIFIED', height: 42 })
    expect(actor.getSnapshot().matches('mined')).toBe(true)
    expect(actor.getSnapshot().context.minedHeight).toBe(42)
  })

  it('ARC double-spend → failed', () => {
    const actor = createActor(txLifecycleMachine).start()
    actor.send({ type: 'START', id: 't2' })
    actor.send({ type: 'VALIDATED' })
    actor.send({ type: 'DISPATCH' })
    actor.send({ type: 'ARC', status: 'DOUBLE_SPEND_ATTEMPTED' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.diagnostic).toBe('ARC_DOUBLE_SPEND')
  })

  it('reorg from mined → orphaned → mempool', () => {
    const actor = createActor(txLifecycleMachine).start()
    actor.send({ type: 'START', id: 't3' })
    actor.send({ type: 'VALIDATED' })
    actor.send({ type: 'DISPATCH' })
    actor.send({ type: 'MEMPOOL' })
    actor.send({ type: 'BUMP_VERIFIED', height: 1 })
    actor.send({ type: 'REORG' })
    expect(actor.getSnapshot().matches('reorgOrphaned')).toBe(true)
    actor.send({ type: 'REANNOUNCED' })
    expect(actor.getSnapshot().matches('seenInMempool')).toBe(true)
  })
})
