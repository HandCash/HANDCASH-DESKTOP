import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { Button } from '@aeon-ui/react'
import { onboardEmailMachine } from '../machines/onboardEmailMachine'

export const ONBOARD_EMAIL_LEDE =
  'When a new device can’t reach this one on your local network, it signs in with a code sent to this email, and you approve it here. HandCash keeps only a keyed hash of the address. You can add it later in Settings.'

/** Every face here is `onboardEmailMachine`; a saved or skipped email moves onboarding on. */
export function OnboardEmailPanel({ onDone }: { onDone: () => void }) {
  const [snapshot, send] = useMachine(onboardEmailMachine)
  const stateAttr = stateToAttr(snapshot.value)
  const { email, code, error } = snapshot.context
  const sending = snapshot.matches('sending')
  const saving = snapshot.matches('saving')
  const onCode = snapshot.matches('code') || saving

  useEffect(() => {
    if (snapshot.status === 'done') onDone()
  }, [snapshot.status, onDone])

  return (
    <div className="wallet-setup-config" data-aeon-scope="onboard-email" data-aeon-state={stateAttr}>
      <h2>Add a sign-in email</h2>
      <p className="auth-lede">{ONBOARD_EMAIL_LEDE}</p>

      {onCode ? (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            send({ type: 'CONFIRM' })
          }}
        >
          <p className="settings-hint">Enter the 6-digit code sent to {email.trim()}.</p>
          <label className="field">
            <span className="field-label">Code</span>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={saving}
              onChange={(e) => send({ type: 'EDIT_CODE', code: e.target.value })}
            />
          </label>
          <div className="auth-actions" data-aeon-part="onboard-email-actions" data-aeon-state={stateAttr}>
            <Button.Root type="submit" variant="solid" className="btn btn-primary auth-submit" disabled={saving || code.length !== 6}>
              <Button.Label>{saving ? 'Saving…' : 'Save'}</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={saving} onClick={() => send({ type: 'BACK' })}>
              <Button.Label>Use another email</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={saving} onClick={() => send({ type: 'SKIP' })}>
              <Button.Label>Skip for now</Button.Label>
            </Button.Root>
          </div>
        </form>
      ) : (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            send({ type: 'SEND' })
          }}
        >
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              disabled={sending}
              onChange={(e) => send({ type: 'EDIT_EMAIL', email: e.target.value })}
            />
          </label>
          <div className="auth-actions" data-aeon-part="onboard-email-actions" data-aeon-state={stateAttr}>
            <Button.Root type="submit" variant="solid" className="btn btn-primary auth-submit" disabled={sending || !email.trim()}>
              <Button.Label>{sending ? 'Sending…' : 'Send code'}</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={sending} onClick={() => send({ type: 'SKIP' })}>
              <Button.Label>Skip for now</Button.Label>
            </Button.Root>
          </div>
        </form>
      )}

      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
