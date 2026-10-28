import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { onboardEmailCode, onboardEmailMachine } from './onboardEmailMachine'

function start(options: {
  sendCode?: (email: string) => Promise<{ requestId: string; devCode?: string }>
  register?: (requestId: string, code: string) => Promise<string>
} = {}) {
  const sent: string[] = []
  const registered: Array<[string, string]> = []
  const machine = onboardEmailMachine.provide({
    actors: {
      sendCode: fromPromise<{ requestId: string; devCode?: string }, { email: string }>(({ input }) => {
        sent.push(input.email)
        return options.sendCode ? options.sendCode(input.email) : Promise.resolve({ requestId: 'req-1' })
      }),
      register: fromPromise<string, { requestId: string; code: string }>(({ input }) => {
        registered.push([input.requestId, input.code])
        return options.register ? options.register(input.requestId, input.code) : Promise.resolve('me@example.com')
      }),
    },
  })
  const actor = createActor(machine).start()
  return { actor, sent, registered }
}

describe('onboardEmailMachine', () => {
  it('sends a code to the trimmed email, then saves once the 6-digit code is in', async () => {
    const { actor, sent, registered } = start()
    actor.send({ type: 'EDIT_EMAIL', email: '  me@example.com ' })
    actor.send({ type: 'SEND' })
    await waitFor(actor, (s) => s.matches('code'))
    expect(sent).toEqual(['me@example.com'])

    actor.send({ type: 'EDIT_CODE', code: '12a34' })
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('code')).toBe(true)

    actor.send({ type: 'EDIT_CODE', code: '123 456 7' })
    expect(actor.getSnapshot().context.code).toBe('123456')
    actor.send({ type: 'CONFIRM' })
    const done = await waitFor(actor, (s) => s.status === 'done')
    expect(done.matches('saved')).toBe(true)
    expect(registered).toEqual([['req-1', '123456']])
  })

  it('needs an email before sending, and can be skipped', () => {
    const { actor, sent } = start()
    actor.send({ type: 'EDIT_EMAIL', email: '   ' })
    actor.send({ type: 'SEND' })
    expect(actor.getSnapshot().matches('entering')).toBe(true)
    expect(sent).toEqual([])
    actor.send({ type: 'SKIP' })
    expect(actor.getSnapshot().matches('skipped')).toBe(true)
    expect(actor.getSnapshot().status).toBe('done')
  })

  it('fills the code a dev relay returns', async () => {
    const { actor } = start({ sendCode: async () => ({ requestId: 'req-2', devCode: '654321' }) })
    actor.send({ type: 'EDIT_EMAIL', email: 'me@example.com' })
    actor.send({ type: 'SEND' })
    const snap = await waitFor(actor, (s) => s.matches('code'))
    expect(snap.context.code).toBe('654321')
  })

  it('returns to the email with the reason when sending fails', async () => {
    const { actor } = start({ sendCode: () => Promise.reject(new Error('Enter a valid email address.')) })
    actor.send({ type: 'EDIT_EMAIL', email: 'nope' })
    actor.send({ type: 'SEND' })
    const snap = await waitFor(actor, (s) => s.matches('entering') && s.context.error !== null)
    expect(snap.context.error).toBe('Enter a valid email address.')
    expect(snap.context.email).toBe('nope')
  })

  it('stays on the code with the reason when saving fails, and can go back to change the email', async () => {
    const { actor } = start({ register: () => Promise.reject(new Error('That code is wrong.')) })
    actor.send({ type: 'EDIT_EMAIL', email: 'me@example.com' })
    actor.send({ type: 'SEND' })
    await waitFor(actor, (s) => s.matches('code'))
    actor.send({ type: 'EDIT_CODE', code: '000000' })
    actor.send({ type: 'CONFIRM' })
    const failed = await waitFor(actor, (s) => s.matches('code') && s.context.error !== null)
    expect(failed.context.error).toBe('That code is wrong.')

    actor.send({ type: 'BACK' })
    const back = actor.getSnapshot()
    expect(back.matches('entering')).toBe(true)
    expect(back.context).toMatchObject({ email: 'me@example.com', code: '', requestId: null, error: null })
  })

  it('keeps only digits, at most six', () => {
    expect(onboardEmailCode('12-34 5678')).toBe('123456')
  })
})
