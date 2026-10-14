import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { emailRecoveryMachine } from './emailRecoveryMachine'

describe('emailRecoveryMachine', () => {
  it('does not become ready before Google and mailbox confirmation', () => {
    const actor = createActor(emailRecoveryMachine).start()
    actor.send({ type: 'ENROLL' })
    actor.send({ type: 'BROWSER_OPENED' })
    actor.send({ type: 'GOOGLE_VERIFIED', email: 'person@example.com' })
    expect(actor.getSnapshot().matches({ enrolling: 'mailingShare' })).toBe(true)
    actor.send({ type: 'MAIL_SENT' })
    actor.send({ type: 'CONFIRM_MAILBOX' })
    actor.send({ type: 'MAIL_CONFIRMED' })
    expect(actor.getSnapshot().matches('ready')).toBe(true)
  })

  it('names device approval and delayed recovery as separate paths', () => {
    const approved = createActor(emailRecoveryMachine).start()
    approved.send({ type: 'LOGIN' })
    approved.send({ type: 'BROWSER_OPENED' })
    approved.send({ type: 'DEVICE_FOUND' })
    expect(approved.getSnapshot().matches({ login: 'waitingForChallenge' })).toBe(true)

    const delayed = createActor(emailRecoveryMachine).start()
    delayed.send({ type: 'LOGIN' })
    delayed.send({ type: 'BROWSER_OPENED' })
    delayed.send({ type: 'WAIT_FOR_RECOVERY', releaseAt: Date.now() + 1_000 })
    expect(delayed.getSnapshot().matches({ login: 'delayedRecovery' })).toBe(true)
  })
})
