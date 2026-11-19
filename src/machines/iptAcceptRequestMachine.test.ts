import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { iptAcceptRequestMachine, type IptAcceptRequest } from './iptAcceptRequestMachine'
import type { IptReservationResult } from '../wallet/bnt/iptReservations'

const request: IptAcceptRequest = { sender: 'sender', ef: [1, 2], recipients: [] }

function run(accept: (input: IptAcceptRequest) => Promise<IptReservationResult>) {
  const machine = iptAcceptRequestMachine.provide({
    actors: {
      accept: fromPromise<IptReservationResult, IptAcceptRequest>(({ input }) => accept(input)),
    },
  })
  const actor = createActor(machine).start()
  return actor
}

const settled = (s: { value: unknown }) => s.value !== 'accepting' && s.value !== 'replaying'

describe('iptAcceptRequest chart (BRC-253 §§5–6)', () => {
  it('ends signed with the journaled bytes and accepts nothing after', async () => {
    const actor = run(async () => ({ state: 'signed', requestId: 'r1', signedEf: [9] }))
    actor.send({ type: 'SUBMIT', request })
    const s = await waitFor(actor, settled)
    expect(s.value).toBe('signed')
    expect(s.context).toMatchObject({ requestId: 'r1', signedEf: [9] })
    expect(s.status).toBe('done')
  })

  it('snapshots the request so later mutation cannot change what is validated', async () => {
    let seen: number[] = []
    const actor = run(async (input) => { seen = input.ef; return { state: 'signed', requestId: 'r', signedEf: [1] } })
    const mutable = structuredClone(request)
    actor.send({ type: 'SUBMIT', request: mutable })
    mutable.ef.push(7)
    await waitFor(actor, settled)
    expect(seen).toEqual([1, 2])
  })

  it('refuses a request that failed before any reservation', async () => {
    const actor = run(async () => { throw Object.assign(new Error('IPT input already reserved'), { held: false }) })
    actor.send({ type: 'SUBMIT', request })
    const s = await waitFor(actor, settled)
    expect(s.value).toBe('refused')
    expect(s.context.error).toEqual({ message: 'IPT input already reserved', held: false })
  })

  it('holds a pending or write-failed request, with no cancel or timeout out of it', async () => {
    for (const accept of [
      async (): Promise<IptReservationResult> => ({ state: 'pending', requestId: 'r2' }),
      async (): Promise<IptReservationResult> => { throw Object.assign(new Error('disk failure'), { held: true }) },
    ]) {
      const actor = run(accept)
      actor.send({ type: 'SUBMIT', request })
      await waitFor(actor, settled)
      actor.send({ type: 'CANCEL' })
      expect(actor.getSnapshot().value).toBe('held')
    }
  })

  it('replays only the same request: pending stays held, a failed replay stays held, a journaled signature finishes', async () => {
    const seen: IptAcceptRequest[] = []
    const pending = run(async (input) => { seen.push(input); return { state: 'pending', requestId: 'r3' } })
    pending.send({ type: 'SUBMIT', request })
    await waitFor(pending, settled)
    pending.send({ type: 'REPLAY' })
    expect((await waitFor(pending, settled)).value).toBe('held')
    expect(seen).toEqual([request, request])

    // Even an error claiming nothing is held cannot release inputs on replay.
    let calls = 0
    const failing = run(async () => {
      if (calls++ === 0) return { state: 'pending', requestId: 'r3' }
      throw Object.assign(new Error('offline'), { held: false })
    })
    failing.send({ type: 'SUBMIT', request })
    await waitFor(failing, settled)
    failing.send({ type: 'REPLAY' })
    const still = await waitFor(failing, settled)
    expect(still.value).toBe('held')
    expect(still.context.error).toEqual({ message: 'offline', held: true })

    let replays = 0
    const replayed = run(async () => (replays++ === 0
      ? { state: 'pending', requestId: 'r3' }
      : { state: 'signed', requestId: 'r3', signedEf: [5] }))
    replayed.send({ type: 'SUBMIT', request })
    await waitFor(replayed, settled)
    replayed.send({ type: 'REPLAY' })
    const done = await waitFor(replayed, settled)
    expect(done.value).toBe('signed')
    expect(done.context.signedEf).toEqual([5])
  })

  it('signs nothing by default: the unwired accept actor refuses', async () => {
    const actor = createActor(iptAcceptRequestMachine).start()
    actor.send({ type: 'SUBMIT', request })
    const s = await waitFor(actor, settled)
    expect(s.value).toBe('refused')
  })

  it('can be cancelled only before submission', () => {
    const actor = createActor(iptAcceptRequestMachine).start()
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().value).toBe('cancelled')
  })
})
