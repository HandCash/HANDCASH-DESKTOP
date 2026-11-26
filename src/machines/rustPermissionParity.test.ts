import fs from 'node:fs'
import path from 'node:path'
import { createActor, fromPromise } from 'xstate'
import { expect, it } from 'vitest'
import { permissionDecisionMachine } from './permissionDecisionMachine'
import { grantExpiryMachine, GRANT_EXPIRING_SOON_MS as DAY } from './grantExpiryMachine'
import { importWriteGrantMachine, type ImportReviewDecision } from './importWriteGrantMachine'

it('records permission statechart traces from the executable TS charts', async () => {
  const decisions = []
  // Every sequence of five events, including duplicate decisions and resets.
  for (let n = 0; n < 243; n++) {
    const actor = createActor(permissionDecisionMachine).start()
    const steps = []
    let code = n
    for (let j = 0; j < 5; j++, code = Math.floor(code / 3)) {
      const event = ['APPROVE', 'CANCEL', 'RESET'][code % 3] as 'APPROVE' | 'CANCEL' | 'RESET'
      actor.send({ type: event })
      steps.push({ event, state: actor.getSnapshot().value })
    }
    decisions.push(steps)
    actor.stop()
  }
  const grants = []
  for (const expiresAt of [null, 0, 100, DAY, DAY + 1, 3 * DAY]) {
    for (const events of [
      [{ type: 'TICK' as const, now: DAY }, { type: 'SET_EXPIRY' as const, expiresAt: null, now: DAY }, { type: 'REVOKE' as const }],
      [{ type: 'SET_EXPIRY' as const, expiresAt: 5 * DAY, now: 0 }, { type: 'TICK' as const, now: 4 * DAY }, { type: 'TICK' as const, now: 5 * DAY }, { type: 'REVOKE' as const }],
      [{ type: 'REVOKE' as const }, { type: 'SET_EXPIRY' as const, expiresAt: null, now: 0 }],
    ]) {
      const input = { expiresAt, now: 0 }
      const actor = createActor(grantExpiryMachine, { input }).start()
      const snap = () => ({ state: actor.getSnapshot().value, context: actor.getSnapshot().context, done: actor.getSnapshot().status === 'done' })
      const initial = snap()
      const steps = events.map(event => { actor.send(event); return { event, ...snap() } })
      grants.push({ input, initial, steps })
      actor.stop()
    }
  }
  const writes = []
  for (const scenario of ['allow', 'deny', 'timeout', 'reviewError', 'revoked', 'unauthorized', 'authThrows', 'persistError', 'revokeCommitting']) {
    let resolveReview!: (decision: ImportReviewDecision) => void
    let rejectReview!: () => void
    let resolvePersist!: (receipt: string) => void
    let rejectPersist!: () => void
    let authorized = true
    let persistCalls = 0
    const actor = createActor(importWriteGrantMachine.provide({
      actors: {
        review: fromPromise(() => new Promise<ImportReviewDecision>((resolve, reject) => { resolveReview = resolve; rejectReview = () => reject(new Error('review')); })),
        persist: fromPromise(() => { persistCalls++; return new Promise<string>((resolve, reject) => { resolvePersist = resolve; rejectPersist = () => reject(new Error('persist')); }); }),
      },
    }), { input: { authorized: () => { if (scenario === 'authThrows') throw new Error('scope'); return authorized } } }).start()
    const snap = () => ({ state: actor.getSnapshot().value, refusal: actor.getSnapshot().context.refusal, receipt: actor.getSnapshot().context.receipt, persistCalls, done: actor.getSnapshot().status === 'done' })
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
    const initial = snap()
    const steps = []
    if (scenario === 'revoked') {
      actor.send({ type: 'REVOKE' })
      steps.push({ event: 'revoke', ...snap() })
    }
    if (scenario === 'unauthorized') authorized = false
    if (scenario === 'reviewError') rejectReview()
    else resolveReview(scenario === 'deny' ? 'deny' : scenario === 'timeout' ? 'timeout' : 'allow')
    await flush()
    steps.push({ event: scenario === 'reviewError' ? 'reviewError' : 'reviewDone', decision: scenario === 'deny' ? 'deny' : scenario === 'timeout' ? 'timeout' : 'allow', authorizedNow: authorized && scenario !== 'authThrows', ...snap() })
    if (actor.getSnapshot().matches('committing')) {
      if (scenario === 'revokeCommitting') {
        actor.send({ type: 'REVOKE' })
        steps.push({ event: 'revoke', ...snap() })
      }
      if (scenario === 'persistError') rejectPersist()
      else resolvePersist('saved')
      await flush()
      steps.push({ event: scenario === 'persistError' ? 'persistError' : 'persistDone', ...snap() })
    }
    writes.push({ scenario, initial, steps })
    actor.stop()
  }
  expect(writes.find(w => w.scenario === 'unauthorized')!.steps.at(-1)!.refusal).toBe('unauthorized')
  const dir = path.resolve('native-desktop/fixtures/permissions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'traces.json'), JSON.stringify({ decisions, grants, writes }, null, 2) + '\n')
})
