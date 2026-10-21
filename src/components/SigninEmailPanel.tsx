/**
 * The email a new device uses when it can't reach this one on the local
 * network: it gets a code by email, then a signed-in device approves it.
 */
import { Button, StatusBanner } from '@aeon-ui/react'
import { useEffect, useState } from 'react'
import {
  getSigninEmail,
  refreshDeviceSignin,
  registerSigninEmail,
  removeSigninEmail,
  requestSigninCode,
  setSigninEmail,
  signinErrorText,
  subscribeDeviceSignin,
  subscribeSigninEmail,
  walletSigninKeyHex,
} from '../wallet/deviceSignin'

type Step = { step: 'view' } | { step: 'email' } | { step: 'code'; requestId: string }

export function SigninEmailPanel() {
  const [saved, setSaved] = useState(() => getSigninEmail())
  const [registered, setRegistered] = useState<boolean | null>(null)
  const [step, setStep] = useState<Step>({ step: 'view' })
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeSigninEmail(() => setSaved(getSigninEmail())), [])
  useEffect(() => subscribeDeviceSignin((snapshot) => setRegistered(snapshot.registered)), [])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(signinErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = () =>
    run(async () => {
      const issued = await requestSigninCode(email.trim(), 'register')
      setCode(issued.devCode ?? '')
      setStep({ step: 'code', requestId: issued.requestId })
    })

  const confirm = (requestId: string) =>
    run(async () => {
      const result = await registerSigninEmail(walletSigninKeyHex(), requestId, code.trim())
      setSigninEmail(result.email)
      refreshDeviceSignin()
      setStep({ step: 'view' })
    })

  const remove = () =>
    run(async () => {
      await removeSigninEmail(walletSigninKeyHex())
      setSigninEmail(null)
      refreshDeviceSignin()
    })

  const current = saved ?? (registered ? 'Set on another of your devices' : null)

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="signin-email" data-aeon-state={step.step}>
      <h2>Sign-in email</h2>
      <p className="settings-hint">
        A new device signs in by scanning its code with this one, over your local network. When it can&rsquo;t reach
        this device, it uses this email&rsquo;s code instead and you approve it in Activity. HandCash keeps a keyed hash
        of the address and never sees your keys.
      </p>

      {step.step === 'view' ? (
        <>
          <StatusBanner.Root tone={current ? 'success' : 'info'} status={current ? 'set' : 'unset'}>
            <StatusBanner.Copy>
              <StatusBanner.Title>{current ?? 'No sign-in email'}</StatusBanner.Title>
            </StatusBanner.Copy>
          </StatusBanner.Root>
          <div className="actions">
            <Button.Root className="btn btn-primary" onClick={() => setStep({ step: 'email' })}>
              {current ? 'Change email' : 'Add email'}
            </Button.Root>
            {current ? (
              <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button.Root>
            ) : null}
          </div>
        </>
      ) : null}

      {step.step === 'email' ? (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && email.trim()) void sendCode()
          }}
        >
          <label className="field">
            <span className="field-label">Email</span>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div className="actions">
            <Button.Root type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send code'}
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => setStep({ step: 'view' })}>
              Cancel
            </Button.Root>
          </div>
        </form>
      ) : null}

      {step.step === 'code' ? (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && code.trim().length === 6) void confirm(step.requestId)
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
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <div className="actions">
            <Button.Root type="submit" className="btn btn-primary" disabled={busy || code.trim().length !== 6}>
              {busy ? 'Saving…' : 'Save'}
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => setStep({ step: 'view' })}>
              Cancel
            </Button.Root>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
