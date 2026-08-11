import { useCallback, useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import { markCloudKeysBackupConfirmed } from '../wallet/backupStatus'
import { shareDownloadFilename } from '../wallet/brc140Backup'
import { copyText } from '../wallet/clipboard'
import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  depositShareToTrustholder,
  fetchTrustholderInfo,
  getLocalOfflineShare,
  getTrustholderEnrollments,
  getTrustholderSharePlan,
  listTrustholderProviders,
  LOCAL_SHARE_INDEX,
  TrustholderHttpError,
  type DepositOtpRequest,
  type DepositProgress,
  type DepositRegisterRequest,
  type TrustholderOperator,
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
 * BRC-232: each trustholder is independent. Recommended: HandCash + Haste +
 * one offline slice (2-of-3). Deposit one provider at a time.
 */
export function TrustholderBackupPanel() {
  const providers = listTrustholderProviders()
  const [enrollments, setEnrollments] = useState(() => getTrustholderEnrollments().enrollments)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<DepositProgress | null>(null)
  const [portals, setPortals] = useState<Partial<Record<string, string>>>({})
  const [localShare, setLocalShare] = useState<{
    share: string
    integrity: string
    total: number
  } | null>(() => {
    const plan = getTrustholderSharePlan()
    const share = getLocalOfflineShare()
    if (!plan || !share) return null
    return { share, integrity: plan.integrity, total: plan.totalShares }
  })
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
            /* portal optional until deposit */
          }
        }),
      )
      if (!cancelled) setPortals(next)
    })()
    return () => {
      cancelled = true
    }
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

  const runDeposit = async (operator: TrustholderOperator) => {
    if (!password) {
      toastError('Unlock first', 'Confirm your password before depositing.')
      return
    }
    if (!email.includes('@')) {
      toastError('Email required', 'Enter the portal email for this provider.')
      return
    }
    setBusyId(operator)
    setProgress(null)
    try {
      const result = await depositShareToTrustholder({
        operator,
        password,
        email,
        onProgress: setProgress,
        onOtpNeeded: requestOtp,
        onRegisterNeeded: requestRegister,
      })
      setEnrollments(getTrustholderEnrollments().enrollments)
      setLocalShare({
        share: result.localShare,
        integrity: result.integrity,
        total: result.totalShares,
      })
      if (result.enrolledRecommended >= 1) {
        markCloudKeysBackupConfirmed()
      }
      playWalletSound('success')
      toastSuccess(
        `${result.enrollment.operator === 'haste' ? 'Haste' : 'HandCash'} enrolled`,
        result.enrolledRecommended >= result.recommendedTotal
          ? 'Recommended providers done — save your offline slice'
          : `Save your offline slice · ${result.enrolledRecommended}/${result.recommendedTotal} recommended`,
      )
    } catch (err) {
      playWalletSound('error')
      if (err instanceof TrustholderHttpError && err.code === 'not-registered') {
        const portal = err.portal ? withEmailQuery(err.portal, email) : undefined
        if (portal) void openExternalUrl(portal)
        toastError(
          'Register first',
          portal
            ? `Opened portal — register, then deposit again.`
            : err.message,
        )
      } else if (err instanceof Error && err.message === 'Cancelled') {
        toastError('Deposit cancelled')
      } else {
        toastError('Deposit failed', err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusyId(null)
      setProgress(null)
    }
  }

  const recommended = providers.filter((p) => p.recommended)
  const recommendedDone = recommended.filter((p) =>
    enrollments.some((e) => e.operator === p.operator),
  ).length

  const destinations = providers.map((p) => {
    const enrolled = enrollments.find((e) => e.operator === p.operator)
    return {
      id: p.operator,
      label: p.label,
      description: enrolled
        ? `Deposited ${new Date(enrolled.enrolledAt).toLocaleDateString()}`
        : 'Independent · deposit only this provider',
      state:
        busyId === p.operator
          ? ('busy' as const)
          : enrolled
            ? ('enrolled' as const)
            : ('pending' as const),
      enrolledAt: enrolled?.enrolledAt,
      recommended: p.recommended,
      portal: portals[p.operator],
    }
  })

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="trustholder-backup"
      data-aeon-state={busyId ? 'busy' : localShare ? 'local-share' : 'idle'}
    >
      <p className="settings-hint">
        Each trustholder is independent. We recommend HandCash and Haste (one slice each) plus an
        offline slice — any two restore the wallet. Deposit one provider at a time.
      </p>

      {!password ? (
        <ConfirmPasswordGate
          id="trustholder-deposit-password"
          title="Confirm it’s you"
          lede="Unlock once, then deposit to whichever providers you want."
          actionLabel="Unlock"
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
              disabled={Boolean(busyId)}
            />
          </div>
          <p className="settings-row-desc">
            Same email can register at each portal. OTP is per provider when you deposit.
          </p>
          {progress ? (
            <p className="settings-row-desc" data-aeon-part="deposit-progress" role="status">
              {progress.message}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={Boolean(busyId)}
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

      <TrustholderDestinationList
        destinations={destinations}
        recommendedDone={recommendedDone}
        recommendedTotal={recommended.length}
        busyId={busyId}
        offlineShare={
          localShare
            ? {
                share: localShare.share,
                integrity: localShare.integrity,
                total: localShare.total,
                index: LOCAL_SHARE_INDEX,
              }
            : null
        }
        onDeposit={(id) => {
          if (!password) {
            toastError('Unlock first')
            return
          }
          void runDeposit(id as TrustholderOperator)
        }}
        onOpenPortal={(id) => {
          const portal = portals[id]
          if (!portal) {
            toastError('Portal unavailable', 'Could not load provider info yet.')
            return
          }
          playWalletSound('soft')
          void openExternalUrl(withEmailQuery(portal, email))
        }}
        onOfflineCopy={() => void copyText(localShare?.share ?? '', { label: 'offline slice' })}
        onOfflineSave={() => {
          if (!localShare) return
          downloadShare(
            shareDownloadFilename(LOCAL_SHARE_INDEX, localShare.total, localShare.integrity),
            `${localShare.share}\n`,
          )
          playWalletSound('soft')
          toastSuccess('Offline slice saved')
        }}
      />

      {localShare && recommendedDone >= recommended.length ? (
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
        Providers are modular. Recommend two cloud slices plus one offline — recovery needs any two
        of three. HandCash never sees your full key.
      </SettingsFeatureAbout>
    </div>
  )
}
