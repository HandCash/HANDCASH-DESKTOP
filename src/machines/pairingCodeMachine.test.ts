import { describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { pairingCodeMachine, type PairingOutcome } from './pairingCodeMachine'

function start(confirm: (d: string) => Promise<PairingOutcome>, approve = vi.fn(async () => undefined)) {
  const actor = createActor(pairingCodeMachine, { input: { length: 6, attemptsLeft: 3, confirm, approve } }).start()
  const type = (value: string) => actor.send({ type: 'TYPE', value })
  const typeAll = (digits: string) => {
    for (let i = 1; i <= digits.length; i++) type(digits.slice(0, i))
  }
  return { actor, type, typeAll, approve }
}

describe('pairingCode chart', () => {
  it('starts empty and checks by itself on the sixth typed digit, then sends, then approves', async () => {
    const confirm = vi.fn(async () => ({ ok: true }) as PairingOutcome)
    const { actor, typeAll, type, approve } = start(confirm)
    expect(actor.getSnapshot().context.digits).toBe('')
    typeAll('12345')
    expect(confirm).not.toHaveBeenCalled()
    type('123456')
    const done = await waitFor(actor, (s) => s.matches('approved'))
    expect(confirm).toHaveBeenCalledWith('123456')
    expect(approve).toHaveBeenCalledTimes(1)
    expect(done.status).toBe('done')
  })

  it('waits for the receiver receipt before showing approved', async () => {
    let complete!: () => void
    const { actor, typeAll } = start(async () => ({ ok: true }), () => new Promise<void>((resolve) => { complete = resolve }))
    typeAll('123456')
    await waitFor(actor, (s) => s.matches('sending'))
    expect(actor.getSnapshot().status).not.toBe('done')
    complete()
    await waitFor(actor, (s) => s.matches('approved'))
  })

  it('ignores autofill, paste and any multi-character change', () => {
    const confirm = vi.fn(async () => ({ ok: true }) as PairingOutcome)
    const { actor, type } = start(confirm)
    type('123456')
    type('12')
    type('1a')
    expect(actor.getSnapshot().value).toBe('entering')
    expect(actor.getSnapshot().context.digits).toBe('')
    type('1')
    type('123456')
    type('1x')
    expect(actor.getSnapshot().context.digits).toBe('1')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a wrong code clears the field and shows the tries left; success is never shown', async () => {
    const confirm = vi.fn(async () => ({ ok: false, ended: false, attemptsLeft: 2, message: 'Not that code. 2 tries left' }) as PairingOutcome)
    const { actor, typeAll, approve } = start(confirm)
    typeAll('111111')
    const s = await waitFor(actor, (x) => x.matches('entering') && x.context.attemptsLeft === 2)
    expect(s.context).toMatchObject({ digits: '', error: 'Not that code. 2 tries left' })
    expect(approve).not.toHaveBeenCalled()
  })

  it('a locked or expired session ends without sending the wallet', async () => {
    for (const message of ['Too many wrong codes', 'The code expired']) {
      const confirm = vi.fn(async () => ({ ok: false, ended: true, attemptsLeft: 0, message }) as PairingOutcome)
      const { actor, typeAll, approve } = start(confirm)
      typeAll('222222')
      const s = await waitFor(actor, (x) => x.matches('ended'))
      expect(s.context.error).toBe(message)
      expect(approve).not.toHaveBeenCalled()
    }
  })

  it('a failed send ends with the reason and never reaches approved', async () => {
    const confirm = vi.fn(async () => ({ ok: true }) as PairingOutcome)
    const approve = vi.fn(async () => {
      throw new Error('Could not reach Mac')
    })
    const { actor, typeAll } = start(confirm, approve)
    typeAll('333333')
    const s = await waitFor(actor, (x) => x.matches('ended'))
    expect(s.context.error).toBe('Could not reach Mac')
  })

  it('stays sending until runtime-ready verification finishes, not merely code acceptance', async () => {
    let ready!: () => void
    const approve = vi.fn(() => new Promise<void>((resolve) => { ready = resolve }))
    const { actor, typeAll } = start(async () => ({ ok: true }), approve)
    typeAll('123456')
    await waitFor(actor, (s) => s.matches('sending'))
    expect(actor.getSnapshot().status).toBe('active')
    ready()
    await waitFor(actor, (s) => s.matches('approved'))
  })

  it('input is ignored while checking', async () => {
    let release!: (o: PairingOutcome) => void
    const confirm = vi.fn(() => new Promise<PairingOutcome>((r) => (release = r)))
    const { actor, typeAll, type } = start(confirm)
    typeAll('444444')
    expect(actor.getSnapshot().value).toBe('verifying')
    type('4')
    expect(actor.getSnapshot().context.digits).toBe('444444')
    release({ ok: false, ended: false, attemptsLeft: 1, message: 'no' })
    await waitFor(actor, (x) => x.matches('entering'))
  })
})
