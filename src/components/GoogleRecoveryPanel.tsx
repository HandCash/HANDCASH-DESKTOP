import { stateToAttr } from '@aeon-ui/core'
import { Button, Field, StatusBanner } from '@aeon-ui/react'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import { emailRecoveryMachine } from '../machines/emailRecoveryMachine'
import {
  beginGoogleEnrollment,
  completeGoogleEnrollment,
  googleEnrollmentEmail,
  recoveryEmailUrl,
  type GoogleEnrollmentSession,
} from '../wallet/brc250/enrollment'
import { getEmailRecoveryEnrollment } from '../wallet/brc250/store'

type Props = {
  onReady?: () => void
}

async function openSystemUrl(url: string): Promise<void> {
  if (window.handcash?.openExternal) {
    await window.handcash.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function GoogleRecoveryPanel({ onReady }: Props) {
  const [snapshot, send] = useMachine(emailRecoveryMachine)
  const session = useRef<GoogleEnrollmentSession | null>(null)
  const [mailboxCopy, setMailboxCopy] = useState('')
  const existing = getEmailRecoveryEnrollment()

  useEffect(() => {
    if (!snapshot.matches({ enrolling: 'waitingForGoogle' })) return
    let cancelled = false
    const poll = async () => {
      try {
        const active = session.current
        if (!active) return
        const email = await googleEnrollmentEmail(active)
        if (!cancelled && email) send({ type: 'GOOGLE_VERIFIED', email })
      } catch (error) {
        if (!cancelled) {
          send({
            type: 'FAIL',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [snapshot.value, send])

  if (existing?.mailboxConfirmed) {
    return (
      <div
        data-aeon-scope="google-recovery"
        data-aeon-state="ready"
        className="split-backup-shares"
      >
        <StatusBanner.Root tone="success">
          <StatusBanner.Copy>
            <StatusBanner.Title>Google recovery ready</StatusBanner.Title>
            <StatusBanner.Body>
              {existing.email} · protected by this device or a seven-day two-share recovery.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      </div>
    )
  }

  const start = async () => {
    send({ type: 'ENROLL' })
    try {
      const next = await beginGoogleEnrollment()
      session.current = next
      await openSystemUrl(next.attempt.openUrl)
      send({ type: 'BROWSER_OPENED' })
    } catch (error) {
      send({
        type: 'FAIL',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const emailShare = async () => {
    const active = session.current
    const email = snapshot.context.email
    if (!active || !email) return
    await openSystemUrl(recoveryEmailUrl(email, active.mailboxShare))
    send({ type: 'MAIL_SENT' })
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
      send({
        type: 'FAIL',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div
      data-aeon-scope="google-recovery"
      data-aeon-state={stateToAttr(snapshot.value)}
      className="split-backup-shares"
    >
      {snapshot.matches('idle') ? (
        <>
          <h3>Recommended: Google + email recovery</h3>
          <p className="settings-hint">
            Google identifies your account without typing an email. One encrypted share stays
            with the recovery host and one is emailed to yourself. Neither can open the vault
            alone.
          </p>
          <Button.Root variant="solid" className="btn btn-primary" onClick={() => void start()}>
            <Button.Label>Continue with Google</Button.Label>
          </Button.Root>
        </>
      ) : null}

      {snapshot.matches({ enrolling: 'openingBrowser' }) ? (
        <StatusBanner.Root tone="info">
          <StatusBanner.Title>Opening Google…</StatusBanner.Title>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches({ enrolling: 'waitingForGoogle' }) ? (
        <StatusBanner.Root tone="info">
          <StatusBanner.Copy>
            <StatusBanner.Title>Finish in your browser</StatusBanner.Title>
            <StatusBanner.Body>
              Choose your Google account, then return here. You never type the address into
              HandCash.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches({ enrolling: 'mailingShare' }) ? (
        <>
          <h3>Email one share to yourself</h3>
          <p className="settings-hint">
            Google confirmed {snapshot.context.email}. Your mail app will open already addressed
            to that account.
          </p>
          <Button.Root variant="solid" className="btn btn-primary" onClick={() => void emailShare()}>
            <Button.Label>Open recovery email</Button.Label>
          </Button.Root>
        </>
      ) : null}

      {snapshot.matches({ enrolling: 'confirmingMailbox' }) ? (
        <>
          <h3>Confirm the email arrived</h3>
          <p className="settings-hint">
            Open the email you sent, copy its recovery share, and paste it here. This proves the
            second share is retrievable before HandCash calls recovery ready.
          </p>
          <Field.Root className="field">
            <Field.Label htmlFor="recovery-mailbox-share">Recovery share</Field.Label>
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
              <Button.Label>Confirm recovery</Button.Label>
            </Button.Root>
          </div>
        </>
      ) : null}

      {snapshot.matches({ enrolling: 'depositingHostShare' }) ? (
        <StatusBanner.Root tone="info">
          <StatusBanner.Title>Securing recovery…</StatusBanner.Title>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches('failed') ? (
        <StatusBanner.Root tone="danger">
          <StatusBanner.Copy>
            <StatusBanner.Title>Recovery setup stopped</StatusBanner.Title>
            <StatusBanner.Body>{snapshot.context.error}</StatusBanner.Body>
          </StatusBanner.Copy>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => void start()}>
            <Button.Label>Try again</Button.Label>
          </Button.Root>
        </StatusBanner.Root>
      ) : null}
    </div>
  )
}
