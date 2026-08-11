import { useCallback, useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import { markCloudKeysBackupConfirmed } from '../wallet/backupStatus'
import { shareDownloadFilename } from '../wallet/brc140Backup'
import { copyText } from '../wallet/clipboard'
import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  depositSharesToTrustholders,
  fetchTrustholderInfo,
  getTrustholderEnrollments,
  listTrustholderProviders,
  TrustholderHttpError,
  type DepositOtpRequest,
  type DepositProgress,
  type DepositRegisterRequest,
} from '../wallet/trustholderBackup'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { TrustholderDestinationList } from './KeySliceList'
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

async function openExternalUrl(url: string) {
  if (window.handcash?.openExternal) {
    await window.handcash.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function withEmailQuery(portal: string, email: string): string {
  try {
    const url = new URL(portal)
    if (email.includes('@')) url.searchParams.set('email', email.trim())
    return url.toString()
  } catch {
    return portal
  }
}

type OtpGate = DepositOtpRequest & {
  resolve: (code: string) => void
  reject: (err: Error) => void
}

type RegisterGate = DepositRegisterRequest & {
  resolve: () => void
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
  const [portals, setPortals] = useState<Partial<Record<string, string>>>({})
  const [localShare, setLocalShare] = useState<{
    share: string
    integrity: string
    total: number
  } | null>(null)
  const [otpGate, setOtpGate] = useState<OtpGate | null>(null)
  const [otpDraft, setOtpDraft] = useState('')
  const [registerGate, setRegisterGate] = useState<RegisterGate | null>(null)
  const otpRef = useRef<OtpGate | null>(null)
  const registerRef = useRef<RegisterGate | null>(null)
  const skipOtpDismiss = useRef(false)
  const skipRegisterDismiss = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Partial<Record<string, string>> = {}
      await Promise.all(
        providers.map(async (p) => {
          try {
            const info = await fetchTrustholderInfo(p.baseUrl)
            if (info.portal) next[p.operator] = info.portal
          } catch {
            /* portal links stay optional until deposit */
          }
        }),
      )
      if (!cancelled) setPortals(next)
    })()
    return () => {
      cancelled = true
    }
    // Providers are stable URL prefs for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestOtp = useCallback((req: DepositOtpRequest) => {
    return new Promise<string>((resolve, reject) => {
      const gate: OtpGate = { ...req, resolve, reject }
      otpRef.current = gate
      setOtpDraft(req.devCode?.trim() || '')
      setOtpGate(gate)
    })
  }, [])

  const requestRegister = useCallback((req: DepositRegisterRequest) => {
    return new Promise<void>((resolve, reject) => {
      const gate: RegisterGate = { ...req, resolve, reject }
      registerRef.current = gate
      setRegisterGate(gate)
      void openExternalUrl(req.portal)
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

  const closeRegister = (ok: boolean) => {
    const gate = registerRef.current
    registerRef.current = null
    if (ok) skipRegisterDismiss.current = true
    setRegisterGate(null)
    if (!gate) return
    if (ok) gate.resolve()
    else gate.reject(new Error('Cancelled'))
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
        onRegisterNeeded: requestRegister,
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
        const portal = err.portal ? withEmailQuery(err.portal, email) : undefined
        if (portal) void openExternalUrl(portal)
        toastError(
          'Register first',
          portal
            ? `Opened ${portal.split('?')[0]} — register, then try again.`
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

  const destinations = providers.map((p) => {
    const enrolled = enrollments.find((e) => e.operator === p.operator)
    return {
      id: p.operator,
      label: p.label,
      description: enrolled
        ? `Deposited ${new Date(enrolled.enrolledAt).toLocaleDateString()}`
        : 'Deposit a slice during enrollment below',
      state: enrolled ? ('enrolled' as const) : ('pending' as const),
      enrolledAt: enrolled?.enrolledAt,
    }
  })

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

      <TrustholderDestinationList
        destinations={destinations}
        offlineShare={
          localShare
            ? {
                share: localShare.share,
                integrity: localShare.integrity,
                total: localShare.total,
                index: localShare.total - 1,
              }
            : null
        }
        onOfflineCopy={() => void copyText(localShare?.share ?? '', { label: 'offline slice' })}
        onOfflineSave={() => {
          if (!localShare) return
          downloadShare(
            shareDownloadFilename(localShare.total - 1, localShare.total, localShare.integrity),
            `${localShare.share}\n`,
          )
          playWalletSound('soft')
          toastSuccess('Offline slice saved')
        }}
      />

      {localShare ? (
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              playWalletSound('soft')
              openSetting('history-backup', { replace: true })
            }}
          >
            Continue to history backup
          </button>
        </div>
      ) : null}

      {!localShare && !password ? (
        <ConfirmPasswordGate
          id="trustholder-deposit-password"
          title="Confirm it’s you"
          lede="Unlock to create BRC-140 slices and deposit them to HandCash and Haste."
          actionLabel="Unlock deposit"
          onVerified={(pw) => setPassword(pw)}
        />
      ) : !localShare ? (
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
            Register the same email at each provider portal once, then deposit. OTP is required for
            each trustholder.
          </p>
          <div className="actions" style={{ flexWrap: 'wrap' }}>
            {providers.map((p) => {
              const portal = portals[p.operator]
              if (!portal) return null
              return (
                <button
                  key={p.operator}
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    playWalletSound('soft')
                    void openExternalUrl(withEmailQuery(portal, email))
                  }}
                >
                  Open {p.label} portal
                </button>
              )
            })}
          </div>
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
      ) : null}

      <Prompt.Root
        open={Boolean(registerGate)}
        status={registerGate ? 'pending' : 'dismissed'}
        onOpenChange={(open) => {
          if (open) return
          if (skipRegisterDismiss.current) {
            skipRegisterDismiss.current = false
            return
          }
          closeRegister(false)
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            {registerGate ? (
              <Prompt.Content
                className="panel modal permission-modal"
                data-aeon-scope="trustholder-register"
              >
                <Prompt.Title>Register at {registerGate.label}</Prompt.Title>
                <Prompt.Description>
                  {registerGate.email} is not registered yet. Finish registration in the browser,
                  then continue here.
                </Prompt.Description>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void openExternalUrl(registerGate.portal)}
                  >
                    Open portal
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => closeRegister(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => closeRegister(true)}
                  >
                    I’ve registered
                  </button>
                </div>
              </Prompt.Content>
            ) : null}
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>

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
                  {otpGate.portal ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void openExternalUrl(otpGate.portal!)}
                    >
                      Open portal
                    </button>
                  ) : null}
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
