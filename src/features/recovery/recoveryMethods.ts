import type { EmailRecoveryEnrollment } from '../../wallet/brc250/types'

/** Where HandCash Recovery setup stands, flattened from `emailRecoveryMachine`. */
export type RecoveryStage =
  | 'idle'
  | 'openingBrowser'
  | 'waitingForGoogle'
  | 'mailingShare'
  | 'confirmingMailbox'
  | 'depositingHostShare'
  | 'ready'
  | 'failed'

export type RecoveryMethodStatus = {
  text: string
  tone: 'ok' | 'warn' | 'muted'
}

const ENROLLING_STAGES: readonly RecoveryStage[] = [
  'openingBrowser',
  'waitingForGoogle',
  'mailingShare',
  'confirmingMailbox',
  'depositingHostShare',
]

/** A saved enrollment wins: recovery is on whatever this screen's chart says. */
export function recoveryStage(value: unknown, enrollment: EmailRecoveryEnrollment | null): RecoveryStage {
  if (enrollment?.mailboxConfirmed) return 'ready'
  if (value === 'idle' || value === 'ready' || value === 'failed') return value
  if (value && typeof value === 'object' && 'enrolling' in value) {
    const step = (value as { enrolling: unknown }).enrolling
    if (ENROLLING_STAGES.includes(step as RecoveryStage)) return step as RecoveryStage
  }
  return 'idle'
}

export function googleMethodStatus(stage: RecoveryStage, email: string | null): RecoveryMethodStatus {
  if (stage === 'openingBrowser') return { text: 'Opening your browser…', tone: 'muted' }
  if (stage === 'waitingForGoogle') return { text: 'Finish signing in in your browser', tone: 'muted' }
  if (email && stage !== 'idle') return { text: `Signed in as ${email}`, tone: 'ok' }
  return { text: 'Not set up', tone: 'warn' }
}

export function emailMethodStatus(stage: RecoveryStage, email: string | null): RecoveryMethodStatus {
  if (stage === 'ready' && email) return { text: `Share confirmed in ${email}`, tone: 'ok' }
  if (stage === 'mailingShare' && email) return { text: `Opening a draft to ${email}…`, tone: 'muted' }
  if (stage === 'confirmingMailbox') return { text: 'Send the draft, then paste its share here', tone: 'warn' }
  if (stage === 'depositingHostShare') return { text: 'Turning on recovery…', tone: 'muted' }
  if (stage === 'failed' && email) return { text: 'Share not confirmed', tone: 'warn' }
  return { text: 'Waits on Google sign-in', tone: 'muted' }
}

/** Settings list rows: no setup is running there, so only the saved enrollment counts. */
export function savedRecoveryStatuses(enrollment: EmailRecoveryEnrollment | null): {
  google: RecoveryMethodStatus
  email: RecoveryMethodStatus
} {
  const stage = enrollment?.mailboxConfirmed ? 'ready' : 'idle'
  const email = enrollment?.mailboxConfirmed ? enrollment.email : null
  return { google: googleMethodStatus(stage, email), email: emailMethodStatus(stage, email) }
}
