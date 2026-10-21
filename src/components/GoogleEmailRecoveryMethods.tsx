import { Button, Field, StatusBanner } from '@aeon-ui/react'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  emailMethodStatus,
  googleMethodStatus,
  recoveryStage,
  type RecoveryMethodStatus,
} from '../features/recovery'
import { emailRecoveryMachine } from '../machines/emailRecoveryMachine'
import {
  beginGoogleEnrollment,
  completeGoogleEnrollment,
  googleEnrollmentEmail,
  recoveryEmailUrl,
  type GoogleEnrollmentSession,
} from '../wallet/brc250/enrollment'
import { getEmailRecoveryEnrollment } from '../wallet/brc250/store'
import { openInSystemBrowser } from '../wallet/brc250/systemBrowser'

type Props = {
  onReady?: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function RecoveryMethod({
  method,
  title,
  about,
  status,
  children,
}: {
  method: 'google' | 'email'
  title: string
  about: string
  status: RecoveryMethodStatus
  children?: ReactNode
}) {
  return (
    <li className="recovery-method" data-aeon-part={`recovery-${method}`} data-aeon-state={status.tone}>
      <div className="recovery-method-head">
        <strong>{title}</strong>
        <span className="recovery-method-status">{status.text}</span>
      </div>
      <p className="settings-hint">{about}</p>
      {children}
    </li>
  )
}

/**
 * Google proves who you are, email holds the second share. Not shown until the
 * secure enclave holders exist; kept so it can come back then.
 */
export function GoogleEmailRecoveryMethods({ onReady }: Props) {
  const [snapshot, send] = useMachine(emailRecoveryMachine)
  const session = useRef<GoogleEnrollmentSession | null>(null)
  const draftOpenedFor = useRef<string | null>(null)
  const [mailboxCopy, setMailboxCopy] = useState('')
  const enrollment = getEmailRecoveryEnrollment()
  const stage = recoveryStage(snapshot.value, enrollment)
  const email = enrollment?.mailboxConfirmed ? enrollment.email : snapshot.context.email

  useEffect(() => {
    if (stage !== 'waitingForGoogle') return
    let cancelled = false
    const poll = async () => {
      try {
        const active = session.current
        if (!active) return
        const verified = await googleEnrollmentEmail(active)
        if (!cancelled && verified) send({ type: 'GOOGLE_VERIFIED', email: verified })
      } catch (error) {
        if (!cancelled) send({ type: 'FAIL', message: messageOf(error) })
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [stage, send])

  const openDraft = async () => {
    const active = session.current
    if (!active || !email) return
    await openInSystemBrowser(recoveryEmailUrl(email, active.mailboxShare))
  }

  useEffect(() => {
    const binding = session.current?.attempt.binding ?? null
    if (stage !== 'mailingShare' || !binding || draftOpenedFor.current === binding) return
    draftOpenedFor.current = binding
    openDraft().then(
      () => send({ type: 'MAIL_SENT' }),
      (error) => send({ type: 'FAIL', message: messageOf(error) }),
    )
  })

  const start = async () => {
    send({ type: 'ENROLL' })
    setMailboxCopy('')
    try {
      const next = await beginGoogleEnrollment()
      session.current = next
      await openInSystemBrowser(next.attempt.openUrl)
      send({ type: 'BROWSER_OPENED' })
    } catch (error) {
      send({ type: 'FAIL', message: messageOf(error) })
    }
  }

  const confirm = async () => {
    const active = session.current
    if (!active || !mailboxCopy.trim()) return
    send({ type: 'CONFIRM_MAILBOX' })
    try {
      await completeGoogleEnrollment(active, mailboxCopy)
      send({ type: 'MAIL_CONFIRMED' })
      onReady?.()
    } catch (error) {
      send({ type: 'FAIL', message: messageOf(error) })
    }
  }

  const googleStatus = googleMethodStatus(stage, email)
  const canStart = stage === 'idle'

  return (
    <div data-aeon-scope="handcash-recovery" data-aeon-state={stage} className="split-backup-shares">
      <p className="settings-hint">
        HandCash provides this recovery, not Google or your email provider. Your wallet key is split
        into shares: HandCash&rsquo;s recovery server keeps one, your email keeps another, and
        neither opens the wallet alone.
      </p>

      <ul className="recovery-methods">
        <RecoveryMethod
          method="google"
          title="Google"
          about="Proves it’s you with the Google account already signed in to your browser. HandCash’s recovery server checks the sign-in; Google never holds a share."
          status={googleStatus}
        >
          {canStart ? (
            <div className="actions">
              <Button.Root variant="solid" className="btn btn-primary" onClick={() => void start()}>
                <Button.Label>Continue with Google</Button.Label>
              </Button.Root>
            </div>
          ) : null}
          {stage === 'waitingForGoogle' && session.current ? (
            <div className="actions">
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                onClick={() => void openInSystemBrowser(session.current!.attempt.openUrl)}
              >
                <Button.Label>Open Google again</Button.Label>
              </Button.Root>
            </div>
          ) : null}
        </RecoveryMethod>

        <RecoveryMethod
          method="email"
          title="Email"
          about="Holds the second share. HandCash puts it in a draft to your Google address; send it, then paste the share back once to prove it arrived."
          status={emailMethodStatus(stage, email)}
        >
          {stage === 'confirmingMailbox' ? (
            <>
              <Field.Root className="field">
                <Field.Label htmlFor="recovery-mailbox-share">Share from the email</Field.Label>
                <Field.Textarea
                  id="recovery-mailbox-share"
                  className="mono"
                  rows={4}
                  value={mailboxCopy}
                  onChange={(event) => setMailboxCopy(event.target.value)}
                  placeholder="Paste the share from your email"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field.Root>
              <div className="actions">
                <Button.Root
                  variant="solid"
                  className="btn btn-primary"
                  disabled={!mailboxCopy.trim()}
                  onClick={() => void confirm()}
                >
                  <Button.Label>Confirm share</Button.Label>
                </Button.Root>
                <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => void openDraft()}>
                  <Button.Label>Open draft again</Button.Label>
                </Button.Root>
              </div>
            </>
          ) : null}
        </RecoveryMethod>
      </ul>

      {stage === 'ready' ? (
        <p className="settings-hint">
          To restore, sign in with Google on the new device and approve it on one you used in the
          last seven days. With none, recovery waits seven days, then asks for the share from your
          email.
        </p>
      ) : null}

      {stage === 'failed' ? (
        <StatusBanner.Root tone="danger">
          <StatusBanner.Copy>
            <StatusBanner.Title>Recovery setup stopped</StatusBanner.Title>
            <StatusBanner.Body>{snapshot.context.error}</StatusBanner.Body>
          </StatusBanner.Copy>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => void start()}>
            <Button.Label>Start again</Button.Label>
          </Button.Root>
        </StatusBanner.Root>
      ) : null}
    </div>
  )
}
