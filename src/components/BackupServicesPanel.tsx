import { useCallback, useEffect, useState } from 'react'
import {
  deleteBackupShare,
  enrollBackupShare,
  fetchBackupServiceInfo,
  isLifecycleWarning,
  retrieveBackupShare,
  startBackupServiceAuth,
  userIdHashFromEmail,
  verifyBackupServiceAuth,
  type BackupServiceInfo,
} from '../wallet/backupServiceClient'
import {
  addBackupServiceUrl,
  getBackupServicePrefs,
  removeBackupServiceUrl,
  upsertEnrollment,
  type BackupServiceEnrollment,
  type BackupServicePrefs,
} from '../wallet/backupServicePrefs'
import {
  BRC140_DEFAULT_THRESHOLD,
  BRC140_DEFAULT_TOTAL,
  createBrc140Shares,
} from '../wallet/brc140Backup'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { revealRootKeyHex } from '../wallet/vault'

type ServiceRow = {
  url: string
  info: BackupServiceInfo | null
  error: string | null
  enrollment: BackupServiceEnrollment | undefined
}

export function BackupServicesPanel() {
  const [prefs, setPrefs] = useState<BackupServicePrefs>(() => getBackupServicePrefs())
  const [rows, setRows] = useState<ServiceRow[]>([])
  const [newUrl, setNewUrl] = useState('http://127.0.0.1:8787')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshInfo = useCallback(async (nextPrefs: BackupServicePrefs) => {
    const settled = await Promise.all(
      nextPrefs.urls.map(async (url) => {
        const enrollment = nextPrefs.enrollments.find((e) => e.url === url)
        try {
          const info = await fetchBackupServiceInfo(url)
          return { url, info, error: null, enrollment } satisfies ServiceRow
        } catch (err) {
          return {
            url,
            info: null,
            error: err instanceof Error ? err.message : String(err),
            enrollment,
          } satisfies ServiceRow
        }
      }),
    )
    setRows(settled)
  }, [])

  useEffect(() => {
    void refreshInfo(prefs)
  }, [prefs, refreshInfo])

  const addUrl = () => {
    const next = addBackupServiceUrl(newUrl)
    setPrefs(next)
    playWalletSound('soft')
    toastSuccess(next.urls.length ? 'Backup service added' : 'URL cleared')
  }

  const removeUrl = (url: string) => {
    const next = removeBackupServiceUrl(url)
    setPrefs(next)
    playWalletSound('soft')
    toastSuccess('Removed')
  }

  /** Deposit one slice to every listed service (2-of-N). Needs ≥2 URLs. */
  const enrollAll = async () => {
    if (prefs.urls.length < 2) {
      toastError('Add at least two backup service URLs')
      return
    }
    if (!email.includes('@')) {
      toastError('Enter the email used for backup-service auth')
      return
    }
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Enter your wallet password')
      return
    }
    setBusy(true)
    try {
      const rootKeyHex = await revealRootKeyHex(password)
      const total = Math.max(prefs.urls.length, BRC140_DEFAULT_TOTAL)
      const threshold = BRC140_DEFAULT_THRESHOLD
      const shareSet = createBrc140Shares(rootKeyHex, threshold, total)
      const userIdHash = await userIdHashFromEmail(email)

      for (let i = 0; i < prefs.urls.length; i++) {
        const url = prefs.urls[i]!
        const share = shareSet.shares[i]
        if (!share) throw new Error(`Missing share index ${i}`)
        const started = await startBackupServiceAuth(url, email)
        const code = started.devCode
        if (!code) {
          throw new Error(
            `${url}: this build expects a local/dev service that returns devCode. Production OTP UI comes next.`,
          )
        }
        const { token } = await verifyBackupServiceAuth(url, started.requestId, code)
        await enrollBackupShare(url, token, userIdHash, share)
        const info = await fetchBackupServiceInfo(url)
        upsertEnrollment({
          url,
          label: info.name,
          userIdHash,
          shareIndex: i,
          integrity: shareSet.integrity,
          enrolledAt: Date.now(),
          email: email.trim().toLowerCase(),
        })
      }
      const next = getBackupServicePrefs()
      setPrefs(next)
      setPassword('')
      playWalletSound('unlock')
      toastSuccess(
        'Slices deposited',
        `${prefs.urls.length} services · ${threshold}-of-${total}`,
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Enroll failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const rotateFrom = async (url: string) => {
    const enrollment = prefs.enrollments.find((e) => e.url === url)
    if (!enrollment) {
      toastError('No enrollment on this service')
      return
    }
    const successor =
      rows.find((r) => r.url === url)?.info?.lifecycle.successorUrl?.trim() ||
      prefs.urls.find((u) => u !== url)
    if (!successor) {
      toastError('Add a replacement backup service URL first')
      return
    }
    if (!email && !enrollment.email) {
      toastError('Enter the enrollment email')
      return
    }
    const useEmail = (email || enrollment.email).trim().toLowerCase()
    setBusy(true)
    try {
      const startOld = await startBackupServiceAuth(url, useEmail)
      const codeOld = startOld.devCode
      if (!codeOld) throw new Error('Dev OTP required for local rotate')
      const { token: tokenOld } = await verifyBackupServiceAuth(url, startOld.requestId, codeOld)
      const share = await retrieveBackupShare(url, tokenOld, enrollment.userIdHash)

      const startNew = await startBackupServiceAuth(successor, useEmail)
      const codeNew = startNew.devCode
      if (!codeNew) throw new Error('Dev OTP required for successor')
      const { token: tokenNew } = await verifyBackupServiceAuth(
        successor,
        startNew.requestId,
        codeNew,
      )
      await enrollBackupShare(successor, tokenNew, enrollment.userIdHash, share)
      await deleteBackupShare(url, tokenOld, enrollment.userIdHash)

      let next = addBackupServiceUrl(successor)
      next = removeBackupServiceUrl(url)
      const info = await fetchBackupServiceInfo(successor)
      next = upsertEnrollment({
        ...enrollment,
        url: successor.replace(/\/+$/, ''),
        label: info.name,
        enrolledAt: Date.now(),
        email: useEmail,
      })
      setPrefs(next)
      playWalletSound('soft')
      toastSuccess('Rotated slice', info.name)
    } catch (err) {
      playWalletSound('error')
      toastError('Rotate failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="backup-services"
      data-aeon-state={busy ? 'busy' : 'idle'}
    >
      <p className="settings-hint">
        Optional backup services store one recovery slice each. Keys stay on this device. Desktop
        ships with an empty list — add providers you trust (including a local test service).
      </p>

      <div className="field">
        <label htmlFor="backup-service-url">Service URL</label>
        <div className="settings-log-upload-row">
          <input
            id="backup-service-url"
            className="settings-log-upload-input"
            type="url"
            placeholder="http://127.0.0.1:8787"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn btn-ghost settings-check-btn" onClick={addUrl}>
            Add
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="settings-hint">No backup services configured.</p>
      ) : (
        <ul className="settings-list">
          {rows.map((row) => {
            const warn = row.info ? isLifecycleWarning(row.info.lifecycle) : false
            return (
              <li key={row.url} className="settings-row settings-row-static">
                <div className="settings-log-upload">
                  <strong className="settings-row-label">
                    {row.info?.name ?? 'Backup service'}
                    {warn ? <span className="spec-tag">sunset</span> : null}
                  </strong>
                  <span className="settings-row-desc settings-log-path mono" title={row.url}>
                    {row.url}
                  </span>
                  {row.error ? (
                    <span className="settings-row-desc">{row.error}</span>
                  ) : row.info ? (
                    <span className="settings-row-desc">
                      {row.info.lifecycle.status}
                      {row.info.lifecycle.retireAt
                        ? ` · retire ${row.info.lifecycle.retireAt}`
                        : ''}
                      {row.enrollment ? ' · enrolled' : ' · not enrolled'}
                    </span>
                  ) : null}
                  {row.info?.lifecycle.message ? (
                    <span className="settings-row-desc">{row.info.lifecycle.message}</span>
                  ) : null}
                  <div className="settings-log-upload-row">
                    <button
                      type="button"
                      className="btn btn-ghost settings-check-btn"
                      disabled={busy || !row.enrollment}
                      onClick={() => void rotateFrom(row.url)}
                    >
                      Rotate
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost settings-check-btn"
                      disabled={busy}
                      onClick={() => removeUrl(row.url)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="field">
        <label htmlFor="backup-service-email">Email (service auth)</label>
        <input
          id="backup-service-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </div>
      <div className="field">
        <label htmlFor="backup-service-password">Wallet password</label>
        <input
          id="backup-service-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Unlock to deposit slices"
          autoComplete="current-password"
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || prefs.urls.length < 2}
        onClick={() => void enrollAll()}
      >
        {busy ? 'Working…' : 'Deposit slices to all services'}
      </button>
      <p className="settings-hint">
        Local test: run three <code>backup-service</code> instances (ports 8787–8789), add those URLs,
        deposit slices, then restore via Auth → Services with any two URLs.
      </p>
    </div>
  )
}
