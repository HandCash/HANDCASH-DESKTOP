import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { ITEM_MIGRATE_BUSY_WAITS, itemMigrateRunMachine } from './itemMigrateRunMachine'
import type { ItemMigrateFaultKind } from './itemMigrateRun'

function start(items: number, perTx: number) {
  const run = createActor(itemMigrateRunMachine).start()
  run.send({ type: 'START', items, perTx })
  return run
}

const fault = (kind: ItemMigrateFaultKind, items: number) =>
  ({ type: 'FAULT', fault: kind, items, message: kind }) as const

describe('itemMigrateRunMachine', () => {
  it('moves every bundle and ends done', () => {
    const run = start(5, 3)
    expect(run.getSnapshot().value).toBe('moving')
    run.send({ type: 'SENT', items: 3, propagation: 'accepted' })
    expect(run.getSnapshot().context.queued).toBe(2)
    run.send({ type: 'SENT', items: 2, propagation: 'accepted' })
    expect(run.getSnapshot().value).toBe('done')
    expect(run.getSnapshot().context).toMatchObject({ moved: 5, failed: 0, stopped: null })
  })

  it('ends done with nothing queued', () => {
    expect(start(0, 10).getSnapshot().value).toBe('done')
  })

  it('stops after a bundle that is still propagating when more remain', () => {
    const run = start(4, 2)
    run.send({ type: 'SENT', items: 2, propagation: 'propagating' })
    expect(run.getSnapshot().value).toBe('stopped')
    expect(run.getSnapshot().context).toMatchObject({ moved: 2, queued: 2, stopped: 'propagating' })
  })

  it('finishes when the last bundle is still propagating; nothing waits on its change', () => {
    const run = start(2, 2)
    run.send({ type: 'SENT', items: 2, propagation: 'propagating' })
    expect(run.getSnapshot().value).toBe('done')
  })

  it('halves a rejected bundle and isolates a single bad tip', () => {
    const run = start(4, 4)
    run.send(fault('rejected', 4))
    expect(run.getSnapshot().context.perTx).toBe(2)
    run.send(fault('rejected', 2))
    expect(run.getSnapshot().context.perTx).toBe(1)
    run.send(fault('rejected', 1))
    expect(run.getSnapshot().context).toMatchObject({ queued: 3, failed: 1, perTx: 4 })
    expect(run.getSnapshot().value).toBe('moving')
  })

  it('drops spent tips without halving and sends the rest of the bundle whole', () => {
    const run = start(25, 25)
    run.send(fault('dead-tips', 24))
    expect(run.getSnapshot().value).toBe('moving')
    expect(run.getSnapshot().context).toMatchObject({ queued: 1, failed: 24, perTx: 25 })
    run.send({ type: 'SENT', items: 1, propagation: 'accepted' })
    expect(run.getSnapshot().value).toBe('done')
  })

  it('waits out a busy wallet, then stops', () => {
    const run = start(2, 2)
    for (let i = 0; i < ITEM_MIGRATE_BUSY_WAITS; i++) {
      run.send(fault('busy', 2))
      expect(run.getSnapshot().value).toBe('waitingForWallet')
      run.send({ type: 'WAITED' })
    }
    run.send(fault('busy', 2))
    expect(run.getSnapshot().context.stopped).toBe('busy')
  })

  it('rebuilds once over a spent fee coin, then stops', () => {
    const run = start(2, 2)
    run.send(fault('stale-funding', 2))
    expect(run.getSnapshot().value).toBe('moving')
    run.send(fault('stale-funding', 2))
    expect(run.getSnapshot().context.stopped).toBe('stale-funding')
  })

  it.each(['funds', 'abandoned', 'locked', 'network'] as const)('never halves over a %s fault', (kind) => {
    const run = start(4, 4)
    run.send(fault(kind, 4))
    expect(run.getSnapshot().value).toBe('stopped')
    expect(run.getSnapshot().context).toMatchObject({ stopped: kind, perTx: 4, failed: 0 })
  })
})
