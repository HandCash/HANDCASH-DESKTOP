import { useCallback, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import { markCloudKeysBackupConfirmed } from '../wallet/backupStatus'
import { shareDownloadFilename } from '../wallet/brc140Backup'
import { copyText } from '../wallet/clipboard'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  depositSharesToTrustholders,
  getTrustholderEnrollments,
  listTrustholderProviders,
  TrustholderHttpError,
  type DepositOtpRequest,
  type DepositProgress,
} from '../wallet/trustholderBackup'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

function downloadShare(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

type OtpGate = DepositOtpRequest & {
  resolve: (code: string) => void
  reject: (err: Error) => void
}

/**
 * BRC-232 deposit: 2-of-3 shares → HandCash + Haste; keep one share offline.
 * Modular: wallet/trustholderBackup owns the wire; this panel is presentation only.
 */
export function TrustholderBackupPanel() {
  const providers = listTrustholderProviders()
  const [enrollments, setEnrollments] = useState(() => getTrustholderEnrollments().enrollments)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<DepositProgress | null>(null)
  const [localShare, setLocalShare] = useState<{
    share: string
    integrity: string
    total: number
  } | null>(null)
  const [otpGate, setOtpGate] = useState<OtpGate | null>(null)
  const [otpDraft, setOtpDraft] = useState('')
  const otpRef = useRef<OtpGate | null>(null)
  const skipOtpDismiss = useRef(false)

  const requestOtp = useCallback((req: DepositOtpRequest) => {
    return new Promise<string>((resolve, reject) => {
      const gate: OtpGate = { ...req, resolve, reject }
      otpRef.current = gate
      setOtpDraft(req.devCode?.trim() || '')
      setOtpGate(gate)
    })
  }, [])

  const closeOtp = (ok: boolean) => {
    const gate = otpRef.current
    otpRef.current = null
    if (ok) skipOtpDismiss.current = true
    setOtpGate(null)
    if (!gate) return
    if (ok) {
      const code = otpDraft.trim()
      if (!code) {
        gate.reject(new Error('Enter the verification code'))
        return
      }
      gate.resolve(code)
    } else {
      gate.reject(new Error('Cancelled'))
    }
  }

  const runDeposit = async () => {
    if (!password) return
    setBusy(true)
    setProgress(null)
    setLocalShare(null)
    try {
      const result = await depositSharesToTrustholders({
        password,
        email,
        onProgress: setProgress,
        onOtpNeeded: requestOtp,
      })
      markCloudKeysBackupConfirmed()
      setEnrollments(result.enrollments)
      setLocalShare({
        share: result.localShare,
        integrity: result.integrity,
        total: result.totalShares,
      })
      playWalletSound('success')
      toastSuccess(
        'Key shares deposited',
        `Save your offline slice (${result.threshold}-of-${result.totalShares})`,
      )
    } catch (err) {
      playWalletSound('error')
      if (err instanceof TrustholderHttpError && err.code === 'not-registered') {
        toastError(
          'Register first',
          err.portal
            ? `${err.message} Portal: ${err.portal}`
            : err.message,
        )
      } else if (err instanceof Error && err.message === 'Cancelled') {
        toastError('Deposit cancelled')
      } else {
        toastError('Deposit failed', err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const hc = enrollments.find((e) => e.operator === 'handcash')
  const haste = enrollments.find((e) => e.operator === 'haste')

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="trustholder-backup"
      data-aeon-state={busy ? 'busy' : localShare ? 'local-share' : 'idle'}
    >
      <p className="settings-hint">
        Recommended recovery: deposit one key slice to HandCash and one to Haste (BRC-232). Keep the
        third slice offline. Any two slices restore your wallet.
      </p>

      <ul className="settings-list" data-aeon-part="enrollment-status">
        {providers.map((p) => {
          const enrolled = enrollments.find((e) => e.operator === p.operator)
          return (
            <li key={p.operator} className="settings-row settings-row-static">
              <span className="settings-row-body">
                <strong className="settings-row-label">{p.label}</strong>
                <span
                  className="settings-row-desc"
                  data-aeon-state={enrolled ? 'ok' : 'pending'}
                >
                  {enrolled
                    ? `Enrolled ${new Date(enrolled.enrolledAt).toLocaleDateString()}`
                    : 'Not enrolled'}
                </span>
              </span>
            </li>
          )
        })}
      </ul>

      {!password ? (
        <ConfirmPasswordGate
          id="trustholder-deposit-password"
          title="Confirm it’s you"
          lede="Unlock to create BRC-140 slices and deposit them to HandCash and Haste."
          actionLabel="Unlock deposit"
          onVerified={(pw) => setPassword(pw)}
        />
      ) : (
        <div className="settings-form settings-form-compact" data-aeon-part="deposit-form">
          <div className="field">
            <label htmlFor="trustholder-email">Portal email</label>
            <input
              id="trustholder-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </div>
          <p className="settings-row-desc">
            Register this email at each trustholder portal if you have not already, then enter the
            OTP sent for each provider.
          </p>
          {progress ? (
            <p className="settings-row-desc" data-aeon-part="deposit-progress" role="status">
              {progress.message}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !email.includes('@')}
              onClick={() => void runDeposit()}
            >
              {busy
                ? 'Depositing…'
                : hc && haste
                  ? 'Re-deposit shares'
                  : 'Deposit to HandCash + Haste'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setPassword(null)
                playWalletSound('soft')
              }}
            >
              Lock again
            </button>
          </div>
        </div>
      )}

      {localShare ? (
        <div className="settings-form settings-form-compact" data-aeon-part="local-share">
          <p className="settings-hint">
            Offline slice (3 of {localShare.total}). Integrity{' '}
            <span className="mono">{localShare.integrity}</span>
          </p>
          <code className="mono split-backup-share" style={{ display: 'block', wordBreak: 'break-all' }}>
            {localShare.share}
          </code>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void copyText(localShare.share, { label: 'offline slice' })}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                downloadShare(
                  shareDownloadFilename(2, localShare.total, localShare.integrity),
                  `${localShare.share}\n`,
                )
                playWalletSound('soft')
                toastSuccess('Offline slice saved')
              }}
            >
              Save file
            </button>
          </div>
        </div>
      ) : null}

      <Prompt.Root
        open={Boolean(otpGate)}
        status={otpGate ? 'pending' : 'dismissed'}
        onOpenChange={(open) => {
          if (open) return
          if (skipOtpDismiss.current) {
            skipOtpDismiss.current = false
            return
          }
          closeOtp(false)
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            {otpGate ? (
              <Prompt.Content
                className="panel modal permission-modal"
                data-aeon-scope="trustholder-otp"
              >
                <Prompt.Title>Verify {otpGate.label}</Prompt.Title>
                <Prompt.Description>
                  {otpGate.hint
                    ? `Code sent to ${otpGate.hint}`
                    : otpGate.devCode
                      ? 'Local-only code (email not configured on this Worker)'
                      : 'Enter the email verification code'}
                  {otpGate.portal ? (
                    <>
                      {' '}
                      <a href={otpGate.portal} target="_blank" rel="noreferrer">
                        Open portal
                      </a>
                    </>
                  ) : null}
                </Prompt.Description>
                <div className="field" style={{ marginTop: 12 }}>
                  <label htmlFor="trustholder-otp">Code</label>
                  <input
                    id="trustholder-otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={otpDraft}
                    onChange={(e) => setOtpDraft(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => closeOtp(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!otpDraft.trim()}
                    onClick={() => closeOtp(true)}
                  >
                    Continue
                  </button>
                </div>
              </Prompt.Content>
            ) : null}
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>

      <SettingsFeatureAbout tags={['BRC-232', 'BRC-140']}>
        Trustholders hold encrypted key slices you authorize. HandCash never sees your full key —
        recovery needs any two of three slices.
      </SettingsFeatureAbout>
    </div>
  )
}
