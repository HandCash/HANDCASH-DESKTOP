import { describe, expect, it } from 'vitest'
import type { EmailRecoveryEnrollment } from '../../wallet/brc250/types'
import {
  emailMethodStatus,
  googleMethodStatus,
  recoveryStage,
  savedRecoveryStatuses,
  type RecoveryStage,
} from './recoveryMethods'

const enrollment: EmailRecoveryEnrollment = {
  v: 1,
  host: 'https://recovery.example',
  email: 'ann@gmail.com',
  authorityKey: '02aa',
  attesterKey: '02bb',
  master: { derivation: 'brc-42' },
  mailboxConfirmed: true,
  enrolledAt: 1,
}

describe('recoveryStage', () => {
  it('flattens the enrolling steps of the chart', () => {
    expect(recoveryStage('idle', null)).toBe('idle')
    expect(recoveryStage('failed', null)).toBe('failed')
    expect(recoveryStage({ enrolling: 'waitingForGoogle' }, null)).toBe('waitingForGoogle')
    expect(recoveryStage({ enrolling: 'confirmingMailbox' }, null)).toBe('confirmingMailbox')
  })

  it('reads a saved enrollment as ready, whatever the chart says', () => {
    expect(recoveryStage('idle', enrollment)).toBe('ready')
    expect(recoveryStage({ enrolling: 'openingBrowser' }, enrollment)).toBe('ready')
  })

  it('treats login and unknown values as idle', () => {
    expect(recoveryStage({ login: 'restoring' }, null)).toBe('idle')
    expect(recoveryStage({ enrolling: 'nope' }, null)).toBe('idle')
    expect(recoveryStage(undefined, null)).toBe('idle')
  })
})

describe('method statuses', () => {
  const both = (stage: RecoveryStage, email: string | null) => [
    googleMethodStatus(stage, email),
    emailMethodStatus(stage, email),
  ]

  it('starts with Google to set up and email waiting on it', () => {
    expect(both('idle', null)).toEqual([
      { text: 'Not set up', tone: 'warn' },
      { text: 'Waits on Google sign-in', tone: 'muted' },
    ])
  })

  it('shows sign-in progress on Google only', () => {
    expect(both('waitingForGoogle', null)).toEqual([
      { text: 'Finish signing in in your browser', tone: 'muted' },
      { text: 'Waits on Google sign-in', tone: 'muted' },
    ])
  })

  it('moves to the email once Google confirms the address', () => {
    expect(both('mailingShare', 'ann@gmail.com')).toEqual([
      { text: 'Signed in as ann@gmail.com', tone: 'ok' },
      { text: 'Opening a draft to ann@gmail.com…', tone: 'muted' },
    ])
    expect(emailMethodStatus('confirmingMailbox', 'ann@gmail.com')).toEqual({
      text: 'Send the draft, then paste its share here',
      tone: 'warn',
    })
  })

  it('keeps Google signed in when the email step fails', () => {
    expect(both('failed', 'ann@gmail.com')).toEqual([
      { text: 'Signed in as ann@gmail.com', tone: 'ok' },
      { text: 'Share not confirmed', tone: 'warn' },
    ])
    expect(googleMethodStatus('failed', null)).toEqual({ text: 'Not set up', tone: 'warn' })
  })
})

describe('savedRecoveryStatuses', () => {
  it('reports both methods from the saved enrollment', () => {
    expect(savedRecoveryStatuses(enrollment)).toEqual({
      google: { text: 'Signed in as ann@gmail.com', tone: 'ok' },
      email: { text: 'Share confirmed in ann@gmail.com', tone: 'ok' },
    })
    expect(savedRecoveryStatuses(null)).toEqual({
      google: { text: 'Not set up', tone: 'warn' },
      email: { text: 'Waits on Google sign-in', tone: 'muted' },
    })
  })
})
