/**
 * Sign-in requests on Activity, from request to outcome, on every signed-in
 * device. Approval lives inline in the row: it never takes keyboard focus and
 * a keyboard-triggered click never approves.
 */
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { DevicesIcon } from '../icons'
import { LoadingSpinner } from '../LoadingSpinner'
import {
  approveSignin,
  openSigninDetail,
  refuseSigninFor,
  signinErrorText,
  subscribeDeviceSignin,
  type SigninRowView,
  type SigninSnapshot,
} from '../../wallet/deviceSignin'
import { formatComparisonCode } from '../../wallet/deviceTransfer'
import {
  approveScanLogin,
  listScanLoginRows,
  refuseScanLoginFor,
  subscribeScanLogins,
} from '../../wallet/scanLogin'
import { playWalletSound } from '../../wallet/soundService'

export type SigninApprovalRow = {
  view: SigninRowView
  open: () => Promise<void>
  approve: () => Promise<void>
  refuse: () => Promise<void>
}

export function useSigninApprovals(): readonly SigninApprovalRow[] {
  const [signin, setSignin] = useState<SigninSnapshot>({ registered: null, rows: [] })
  const [scans, setScans] = useState(() => listScanLoginRows())
  useEffect(() => subscribeDeviceSignin(setSignin), [])
  useEffect(() => subscribeScanLogins(() => setScans(listScanLoginRows())), [])
  return useMemo(() => {
    const local: SigninApprovalRow[] = scans.map((view) => ({
      view,
      open: async () => undefined,
      approve: () => approveScanLogin(view.binding),
      refuse: () => refuseScanLoginFor(view.binding),
    }))
    const rows: SigninApprovalRow[] = signin.rows.map((view) => ({
      view,
      open: () => openSigninDetail(view.binding),
      approve: () => approveSignin(view.binding),
      refuse: () => refuseSigninFor(view.binding),
    }))
    return [...local, ...rows]
  }, [signin, scans])
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Pointer only: a click the keyboard produced (detail 0) does nothing. */
function pointerOnly(run: () => void) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) return
    run()
  }
}

export function SigninApprovalRowItem({ row }: { row: SigninApprovalRow }) {
  const { view } = row
  // Opening a waiting request claims it, so only a click opens one: an unattended
  // device showing Activity must not take the comparison away from the user's.
  const [expanded, setExpanded] = useState(view.face === 'claimed' || view.face === 'comparing')
  const [busy, setBusy] = useState<'approve' | 'refuse' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || view.face !== 'waiting') return
    row.open().catch((cause) => setError(signinErrorText(cause)))
  }, [expanded, view.face, row])

  const run = (kind: 'approve' | 'refuse') => {
    if (busy) return
    setBusy(kind)
    setError(null)
    const action = kind === 'approve' ? row.approve : row.refuse
    action()
      .then(() => playWalletSound('soft'))
      .catch((cause) => setError(signinErrorText(cause)))
      .finally(() => setBusy(null))
  }

  return (
    <li
      data-aeon-scope="signin-request"
      data-aeon-state={view.face}
      data-activity-key={view.key}
      data-activity-pending={view.live ? '' : undefined}
    >
      <button
        type="button"
        className="history-row history-row-btn"
        aria-expanded={expanded}
        aria-label={`${view.title}, ${view.detail}`}
        onClick={() => setExpanded((open) => !open)}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" aria-hidden>
              <DevicesIcon size={18} />
            </span>
          </div>
          {view.live ? (
            <span className="history-pending-mark" aria-hidden>
              <LoadingSpinner size="sm" />
            </span>
          ) : null}
        </div>
        <div className="history-body">
          <strong className="history-title">{view.title}</strong>
          <span className="history-when">{view.detail}</span>
        </div>
        <div className="history-amount-block">
          <span className="history-when">{timeOf(view.createdAt)}</span>
        </div>
      </button>
      {expanded ? (
        <div className="signin-detail" data-aeon-part="detail">
          <dl className="signin-facts">
            <dt>Device</dt>
            <dd>{view.label}</dd>
            <dt>Location</dt>
            <dd>
              {view.via === 'local'
                ? 'Your local network'
                : view.location
                  ? `${view.location} (approximate, from HandCash's server)`
                  : 'Unknown'}
            </dd>
            <dt>Requested</dt>
            <dd>{timeOf(view.createdAt)}</dd>
            {view.live ? (
              <>
                <dt>Expires</dt>
                <dd>{timeOf(view.expiresAt)}</dd>
              </>
            ) : null}
          </dl>
          {view.face === 'comparing' && view.code ? (
            <div className="signin-code-block">
              <span className="signin-code" aria-label={`Code ${view.code.split('').join(' ')}`}>
                {formatComparisonCode(view.code)}
              </span>
              <p className="signin-note">Approve only if {view.label} shows this same code.</p>
            </div>
          ) : null}
          {view.face === 'claimed' ? <p className="signin-note">{view.detail}.</p> : null}
          {view.face === 'waiting' ? <p className="signin-note">Getting the code from {view.label}.</p> : null}
          {error ? (
            <p className="signin-error" role="alert">
              {error}
            </p>
          ) : null}
          {view.live ? (
            <div className="signin-actions">
              {view.face === 'comparing' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  tabIndex={-1}
                  disabled={busy !== null}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={pointerOnly(() => run('approve'))}
                >
                  {busy === 'approve' ? 'Sending…' : 'Approve'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost"
                tabIndex={-1}
                disabled={busy !== null}
                onMouseDown={(event) => event.preventDefault()}
                onClick={pointerOnly(() => run('refuse'))}
              >
                {busy === 'refuse' ? 'Refusing…' : 'Refuse'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
