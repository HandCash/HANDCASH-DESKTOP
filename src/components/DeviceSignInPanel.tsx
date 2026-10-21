/**
 * Sign in to an existing wallet on this device.
 *
 * Default: this device shows a QR, a signed-in device scans it, the user
 * approves there and the wallet comes straight over the local network,
 * encrypted to this device's one-time key. Fallback when the devices can't
 * reach each other: the account email's code, then the same approval relayed
 * by HandCash, still end to end. Recovery is offered only when no device can
 * approve.
 */
import { Button, StatusBanner } from '@aeon-ui/react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import {
  advanceNewDeviceSignin,
  requestSigninCode,
  signinErrorText,
  startNewDeviceSignin,
  type NewDeviceSignin,
} from '../wallet/deviceSignin'
import { formatComparisonCode, localDeviceLabel, type VaultTransfer } from '../wallet/deviceTransfer'
import { firstSigninStep } from './auth/authModes'
import {
  endScanLoginSession,
  scanLoginQrText,
  startScanLoginSession,
  subscribeScanLoginSession,
} from '../wallet/scanLogin'

export type ApprovedVault = {
  master: VaultTransfer['master']
  enrollment: VaultTransfer['enrollment']
  accounts: VaultTransfer['accounts']
  /** Set when the email fallback was used. */
  signinEmail: string | null
}



type Props = {
  onSignedIn: (vault: ApprovedVault) => void
  /** Google sign-in, HandCash Recovery, recovery phrase, shares or key. */
  onOtherWays: () => void
  onRecovery: (way: 'google' | 'phrase') => void
  onCancel: () => void
}

export type SigninPhase =
  | { step: 'scan' }
  | { step: 'scan-comparing'; code: string; approverLabel: string }
  | { step: 'email' }
  | { step: 'code'; requestId: string }
  | { step: 'waiting'; noneOnline: boolean }
  | { step: 'comparing'; code: string }
  | { step: 'restoring' }
  | { step: 'ended'; reason: 'refused' | 'expired' }

const POLL_MS = 2_000

export function DeviceSignInPanel({ onSignedIn, onOtherWays, onRecovery, onCancel }: Props) {
  const [phase, setPhase] = useState<SigninPhase>({ step: 'scan' })
  const [qr, setQr] = useState<string | null>(null)
  const [qrRound, setQrRound] = useState(0)
  const [noLocalNetwork, setNoLocalNetwork] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<string[]>([])
  const signin = useRef<NewDeviceSignin | null>(null)

  const scanning = phase.step === 'scan' || phase.step === 'scan-comparing'
  useEffect(() => {
    if (!scanning) return
    let cancelled = false
    let renew: ReturnType<typeof setTimeout> | null = null
    const off = subscribeScanLoginSession((event) => {
      if (event.type === 'connected') {
        setPhase({ step: 'scan-comparing', code: event.code, approverLabel: event.approverLabel })
      } else if (event.type === 'refused') {
        setPhase({ step: 'ended', reason: 'refused' })
      } else {
        setPhase({ step: 'restoring' })
        onSignedIn({
          master: event.transfer.master,
          enrollment: event.transfer.enrollment,
          accounts: event.transfer.accounts,
          signinEmail: null,
        })
      }
    })
    void (async () => {
      const status = await window.handcash?.getBridgeStatus?.().catch(() => null)
      const urls = status?.devicePeerLanUrls ?? []
      if (cancelled) return
      if (firstSigninStep(urls) === 'email') {
        setNoLocalNetwork(true)
        setPhase({ step: 'email' })
        return
      }
      const payload = startScanLoginSession({ urls, label: localDeviceLabel() })
      const dataUrl = await QRCode.toDataURL(scanLoginQrText(payload), {
        width: 240,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      })
      if (cancelled) return
      setQr(dataUrl)
      renew = setTimeout(() => setQrRound((round) => round + 1), payload.expiresAt - Date.now())
    })().catch((cause) => {
      if (!cancelled) setError(signinErrorText(cause))
    })
    return () => {
      cancelled = true
      off()
      if (renew) clearTimeout(renew)
    }
    // A new QR only after the last one expires; comparing keeps the same session.
  }, [scanning, qrRound])

  useEffect(() => () => endScanLoginSession(), [])

  const switchToEmail = () => {
    endScanLoginSession()
    setError(null)
    setPhase({ step: 'email' })
  }

  const sendCode = async () => {
    setBusy(true)
    setError(null)
    try {
      const issued = await requestSigninCode(email.trim(), 'signin')
      setCode(issued.devCode ?? '')
      setPhase({ step: 'code', requestId: issued.requestId })
    } catch (cause) {
      setError(signinErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const confirmCode = async (requestId: string) => {
    setBusy(true)
    setError(null)
    try {
      const started = await startNewDeviceSignin(requestId, code.trim())
      signin.current = started
      setDevices(started.start.devices.map((device) => device.label))
      setPhase({ step: 'waiting', noneOnline: started.start.online === 0 })
    } catch (cause) {
      setError(signinErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const waiting = phase.step === 'waiting' || phase.step === 'comparing'
  useEffect(() => {
    if (!waiting) return
    let cancelled = false
    const poll = async () => {
      const active = signin.current
      if (!active) return
      try {
        const step = await advanceNewDeviceSignin(active)
        if (cancelled) return
        if (step.state === 'comparing') setPhase({ step: 'comparing', code: step.code })
        else if (step.state === 'refused' || step.state === 'expired') setPhase({ step: 'ended', reason: step.state })
        else if (step.state === 'approved') {
          setPhase({ step: 'restoring' })
          onSignedIn({
            master: step.transfer.master,
            enrollment: step.transfer.enrollment,
            accounts: step.transfer.accounts,
            signinEmail: email.trim().toLowerCase(),
          })
        }
      } catch (cause) {
        if (!cancelled) setError(signinErrorText(cause))
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [waiting, email, onSignedIn])

  const restart = () => {
    signin.current = null
    setCode('')
    setError(null)
    setQr(null)
    setPhase({ step: noLocalNetwork ? 'email' : 'scan' })
  }

  const recoveryChoices = (
    <div className="actions" data-aeon-part="recovery">
      <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => onRecovery('google')}>
        Use HandCash Recovery
      </Button.Root>
      <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => onRecovery('phrase')}>
        Use recovery phrase
      </Button.Root>
    </div>
  )

  return (
    <div className="auth-copy device-signin" data-aeon-scope="device-signin" data-aeon-state={phase.step}>
      <h1 className="auth-title">Sign in</h1>

      {phase.step === 'scan' ? (
        <div className="scan-login" data-aeon-part="scan">
          <p className="auth-lede">
            On a device you&rsquo;re signed in on, open Scan and point it at this code. Both devices need the same
            network.
          </p>
          {qr ? (
            <img className="scan-login-qr" src={qr} width={240} height={240} alt="Sign-in code for this device" />
          ) : (
            <div className="scan-login-qr" aria-busy="true" />
          )}
          <p className="auth-alt">
            <button type="button" className="auth-alt-link" data-aeon-part="email-fallback" onClick={switchToEmail}>
              Different network? Sign in with email
            </button>
          </p>
        </div>
      ) : null}

      {phase.step === 'scan-comparing' ? (
        <div className="signin-code-block">
          <span className="signin-code" data-aeon-part="comparison-code">
            {formatComparisonCode(phase.code)}
          </span>
          <p className="auth-lede">
            Approve on {phase.approverLabel} only if it shows this same code. The wallet comes straight over your
            network.
          </p>
        </div>
      ) : null}

      {phase.step === 'email' ? (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && email.trim()) void sendCode()
          }}
        >
          <p className="auth-lede">
            {noLocalNetwork ? 'This device has no local network connection for scanning. ' : ''}
            Enter your wallet&rsquo;s email. Then approve this device on one you&rsquo;re already signed in on;
            HandCash relays it but can&rsquo;t read it.
          </p>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className="actions">
            <Button.Root type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send code'}
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={noLocalNetwork ? onCancel : restart}>
              {noLocalNetwork ? 'Back' : 'Scan instead'}
            </Button.Root>
          </div>
        </form>
      ) : null}

      {phase.step === 'code' ? (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && code.trim()) void confirmCode(phase.requestId)
          }}
        >
          <p className="auth-lede">Enter the 6-digit code sent to {email.trim()}. It expires in 10 minutes.</p>
          <label className="field">
            <span className="field-label">Code</span>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </label>
          <div className="actions">
            <Button.Root type="submit" className="btn btn-primary" disabled={busy || code.trim().length !== 6}>
              {busy ? 'Checking…' : 'Continue'}
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={() => void sendCode()}>
              Send a new code
            </Button.Root>
          </div>
        </form>
      ) : null}

      {phase.step === 'waiting' ? (
        <>
          <StatusBanner.Root tone={phase.noneOnline ? 'warning' : 'info'} status="waiting">
            <StatusBanner.Copy>
              <StatusBanner.Title>Waits on one of your signed-in devices</StatusBanner.Title>
              <StatusBanner.Body>
                {phase.noneOnline
                  ? 'None of your devices checked in during the last 10 minutes. Open HandCash on one, or recover instead.'
                  : `Open Activity on ${devices.slice(0, 2).join(' or ') || 'a signed-in device'} and choose the sign-in request.`}
              </StatusBanner.Body>
            </StatusBanner.Copy>
          </StatusBanner.Root>
          {phase.noneOnline ? recoveryChoices : null}
        </>
      ) : null}

      {phase.step === 'comparing' ? (
        <div className="signin-code-block">
          <span className="signin-code" data-aeon-part="comparison-code">
            {formatComparisonCode(phase.code)}
          </span>
          <p className="auth-lede">Approve on your other device only if it shows this same code.</p>
        </div>
      ) : null}

      {phase.step === 'restoring' ? (
        <StatusBanner.Root tone="info" status="restoring">
          <StatusBanner.Copy>
            <StatusBanner.Title>Approved. Installing your wallet…</StatusBanner.Title>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {phase.step === 'ended' ? (
        <>
          <StatusBanner.Root tone="warning" status={phase.reason}>
            <StatusBanner.Copy>
              <StatusBanner.Title>
                {phase.reason === 'refused' ? 'Your other device refused this sign-in' : 'Nobody approved this sign-in in 10 minutes'}
              </StatusBanner.Title>
            </StatusBanner.Copy>
            <StatusBanner.Action onClick={restart}>Start again</StatusBanner.Action>
          </StatusBanner.Root>
          {phase.reason === 'expired' ? recoveryChoices : null}
        </>
      ) : null}

      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}

      {phase.step === 'scan' ? (
        <p className="auth-alt">
          <button type="button" className="auth-alt-link" onClick={onCancel}>
            Back
          </button>
        </p>
      ) : null}

      {phase.step === 'scan' || phase.step === 'email' || phase.step === 'code' ? (
        <p className="auth-alt">
          <button type="button" className="auth-alt-link" onClick={onOtherWays}>
            Other ways to sign in
          </button>
        </p>
      ) : null}
    </div>
  )
}
