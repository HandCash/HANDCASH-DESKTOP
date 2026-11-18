import { createActor, fromPromise, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { importWriteGrantMachine, type ImportReviewDecision } from './importWriteGrantMachine'

function run(opts: {
  review: () => Promise<ImportReviewDecision>
  persist?: () => Promise<unknown>
  authorized?: () => boolean
}) {
  const persist = vi.fn(opts.persist ?? (async () => ({ id: 'saved' })))
  const actor = createActor(
    importWriteGrantMachine.provide({
      actors: {
        review: fromPromise(opts.review),
        persist: fromPromise(() => persist()),
      },
    }),
    { input: { authorized: opts.authorized ?? (() => true) } },
  )
  actor.start()
  return { actor, persist, done: () => waitFor(actor, (s) => s.status === 'done') }
}

describe('importWriteGrant chart', () => {
  it('writes once after the user approves and the scope still holds', async () => {
    const { persist, done } = run({ review: async () => 'allow' })
    const snap = await done()
    expect(snap.value).toBe('accepted')
    expect(snap.output).toEqual({ receipt: { id: 'saved' }, refusal: null })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['deny', 'denied'],
    ['timeout', 'timeout'],
  ] as const)('a %s review writes nothing', async (decision, refusal) => {
    const { persist, done } = run({ review: async () => decision })
    const snap = await done()
    expect(snap.value).toBe('refused')
    expect(snap.output?.refusal).toBe(refusal)
    expect(persist).not.toHaveBeenCalled()
  })

  it('a failed review is a denial', async () => {
    const { persist, done } = run({ review: async () => { throw new Error('queue gone') } })
    expect((await done()).output?.refusal).toBe('denied')
    expect(persist).not.toHaveBeenCalled()
  })

  it('revoking while the review waits refuses even if approval arrives later', async () => {
    let approve!: (d: ImportReviewDecision) => void
    const { actor, persist, done } = run({ review: () => new Promise((r) => { approve = r }) })
    expect(actor.getSnapshot().value).toBe('pendingReview')
    actor.send({ type: 'REVOKE' })
    approve('allow')
    expect((await done()).output?.refusal).toBe('revoked')
    expect(persist).not.toHaveBeenCalled()
  })

  it('an approval whose scope lapsed (or whose check throws) writes nothing', async () => {
    for (const authorized of [() => false, () => { throw new Error('boom') }]) {
      const { persist, done } = run({ review: async () => 'allow', authorized })
      expect((await done()).output?.refusal).toBe('unauthorized')
      expect(persist).not.toHaveBeenCalled()
    }
  })

  it('a failing write is refused, not accepted', async () => {
    const { done } = run({ review: async () => 'allow', persist: async () => { throw new Error('disk') } })
    const snap = await done()
    expect(snap.value).toBe('refused')
    expect(snap.output).toEqual({ receipt: null, refusal: 'failed' })
  })
})
