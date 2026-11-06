/**
 * Sign in to an existing wallet on this device.
 *
 * This device shows a QR, a signed-in device scans it, and its user types the
 * 6-digit code shown here before the wallet is sent, encrypted to this
 * device's one-time key. Email is not a sign-in method (it belongs to
 * migration only). Recovery is offered when the sign-in expires.
 */
import { Button, StatusBanner } from '@aeon-ui/react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { signinErrorText } from '../wallet/deviceSignin'
import { formatComparisonCode, localDeviceLabel, type VaultTransfer } from '../wallet/deviceTransfer'
import { DeferredImage } from './DeferredImage'
import {
  endScanLoginSession,
  runScanLoginRelay,
  scanLoginQrText,
  startScanLoginSession,
  subscribeScanLoginSession,
} from '../wallet/scanLogin'

export type ApprovedVault = {
  master: VaultTransfer['master']
  enrollment: VaultTransfer['enrollment']
  accounts: VaultTransfer['accounts']
  /** Always null: email is not a sign-in method. */
  signinEmail: string | null
  /** Call once the vault is saved here; until then the relay keeps its sealed copy. */
  acknowledge: () => Promise<void>
}

const nothingToAcknowledge = async () => undefined



type Props = {
  onSignedIn: (vault: ApprovedVault) => void
  /** Recovery phrase, shares or key. */
  onOtherWays: () => void
  /** Recovery phrase, when no device can approve. */
  onRecovery: () => void
  onCancel: () => void
}

export type SigninPhase =
  | { step: 'scan' }
  | { step: 'scan-comparing'; code: string; approverLabel: string }
  | { step: 'restoring' }
  /** The other device accepted the typed code; the wallet is on its way. */
  | { step: 'scan-confirmed'; approverLabel: string }
  | { step: 'ended'; reason: 'refused' | 'expired' | 'locked' }

export function DeviceSignInPanel({ onSignedIn, onOtherWays, onRecovery, onCancel }: Props) {
  const [phase, setPhase] = useState<SigninPhase>({ step: 'scan' })
  const [qr, setQr] = useState<string | null>(null)
  const [qrRound, setQrRound] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const scanning = phase.step === 'scan' || phase.step === 'scan-comparing' || phase.step === 'scan-confirmed'
  useEffect(() => {
    if (!scanning) return
    let cancelled = false
    let renew: ReturnType<typeof setTimeout> | null = null
    let stopRelay: (() => void) | null = null
    const off = subscribeScanLoginSession((event) => {
      if (event.type === 'connected') {
        setPhase({ step: 'scan-comparing', code: event.code, approverLabel: event.approverLabel })
      } else if (event.type === 'confirmed') {
        setPhase((now) => ({
          step: 'scan-confirmed',
          approverLabel: now.step === 'scan-comparing' ? now.approverLabel : 'your other device',
        }))
      } else if (event.type === 'refused') {
        setPhase({ step: 'ended', reason: 'refused' })
      } else if (event.type === 'failed') {
        setPhase({ step: 'ended', reason: event.reason === 'locked' ? 'locked' : 'expired' })
      } else {
        setPhase({ step: 'restoring' })
        onSignedIn({
          master: event.transfer.master,
          enrollment: event.transfer.enrollment,
          accounts: event.transfer.accounts,
          signinEmail: null,
          acknowledge: nothingToAcknowledge,
        })
      }
    })
    void (async () => {
      const status = await window.handcash?.getBridgeStatus?.().catch(() => null)
      const urls = status?.devicePeerLanUrls ?? []
      if (cancelled) return
      const payload = startScanLoginSession({ urls, label: localDeviceLabel() })
      stopRelay = runScanLoginRelay()
      const dataUrl = await QRCode.toDataURL(scanLoginQrText(payload), {
        width: 200,
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
      stopRelay?.()
      if (renew) clearTimeout(renew)
    }
    // A new QR only after the last one expires; comparing keeps the same session.
  }, [scanning, qrRound])

  useEffect(() => () => endScanLoginSession(), [])

  const restart = () => {
    setError(null)
    setQr(null)
    setPhase({ step: 'scan' })
  }

  const recoveryChoices = (
    <div className="actions" data-aeon-part="recovery">
      <Button.Root variant="ghost" className="btn btn-ghost" onClick={onRecovery}>
        Use recovery phrase
      </Button.Root>
    </div>
  )

  return (
    <div className="auth-copy device-signin" data-aeon-scope="device-signin" data-aeon-state={phase.step}>
      <h1 className="auth-title">Sign in</h1>

      {phase.step === 'scan' ? (
        <div className="scan-login" data-aeon-part="scan">
          <p className="auth-lede">Scan with a signed-in device.</p>
          {qr ? (
            <DeferredImage
              className="scan-login-qr"
              src={qr}
              alt="Sign-in code for this device"
              width={200}
              height={200}
              skeletonWidth={200}
              skeletonHeight={200}
              skeletonRadius="var(--hc-radius)"
            />
          ) : (
            <div className="scan-login-qr" aria-busy="true" />
          )}
        </div>
      ) : null}

      {phase.step === 'scan-comparing' ? (
        <div className="signin-code-block">
          <span className="signin-code" data-aeon-part="comparison-code">
            {formatComparisonCode(phase.code)}
          </span>
          <p className="auth-lede">
            Type these numbers on {phase.approverLabel} to let it sign this device in. Only {phase.approverLabel} can
            send the wallet, and only after the right numbers. Don&rsquo;t share them with anyone else.
          </p>
        </div>
      ) : null}

      {phase.step === 'scan-confirmed' ? (
        <StatusBanner.Root tone="info" status="confirmed">
          <StatusBanner.Copy>
            <StatusBanner.Title>Code accepted by {phase.approverLabel}. Receiving your wallet…</StatusBanner.Title>
          </StatusBanner.Copy>
        </StatusBanner.Root>
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
                {phase.reason === 'refused'
                  ? 'Your other device refused this sign-in'
                  : phase.reason === 'locked'
                    ? 'Too many wrong codes. This sign-in was stopped'
                    : 'Nobody approved this sign-in in time'}
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
        <div className="actions" data-aeon-part="exits">
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={onCancel}>
            Back
          </Button.Root>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={onOtherWays}>
            Other ways
          </Button.Root>
        </div>
      ) : null}
    </div>
  )
}
