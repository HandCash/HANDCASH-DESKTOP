/** Activity rows for work still in motion, above the composed records. */
import { Progress } from '@aeon-ui/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CollectablesIcon, RefreshIcon } from '../icons'
import { LoadingSpinner } from '../LoadingSpinner'
import { openSetting } from '../../wallet/navStore'
import { getActiveWallet } from '../../wallet/session'
import { playWalletSound } from '../../wallet/soundService'
import {
  listWalletJobs,
  subscribeWalletJobs,
  walletJobCount,
  walletJobTitle,
  type WalletJob,
  type WalletJobKind,
} from '../../wallet/walletJobs'

const JOB_ICONS: Readonly<Record<WalletJobKind, ReactNode>> = {
  'item-import': <CollectablesIcon size={18} />,
  'wallet-sweep': <CollectablesIcon size={18} />,
  'balance-heal': <RefreshIcon size={18} />,
}

const JOB_SETTING: Readonly<Record<WalletJobKind, 'import' | 'wallet-health'>> = {
  'item-import': 'import',
  'wallet-sweep': 'import',
  'balance-heal': 'wallet-health',
}

/** The open wallet's jobs, newest first. */
export function useWalletJobs(): readonly WalletJob[] {
  const [all, setAll] = useState(() => listWalletJobs())
  useEffect(() => {
    setAll(listWalletJobs())
    return subscribeWalletJobs(() => setAll(listWalletJobs()))
  }, [])
  const identityKey = getActiveWallet()?.identityKey?.toLowerCase() ?? null
  return useMemo(
    () => (identityKey ? all.filter((job) => job.identityKey.toLowerCase() === identityKey) : []),
    [all, identityKey],
  )
}

/** One long wallet job — an import run, a sweep, a balance heal — as a single row with a bar. */
export function WalletJobRow({ job }: { job: WalletJob }) {
  const title = walletJobTitle(job)
  const count = walletJobCount(job)
  const detail = job.error ?? job.detail
  const live = job.face === 'running' || job.face === 'waiting'
  return (
    <li
      data-aeon-scope="wallet-job"
      data-aeon-state={job.face}
      data-aeon-part={job.kind}
      data-activity-key={job.id}
      data-activity-pending={live ? '' : undefined}
    >
      <button
        type="button"
        className="history-row history-row-btn history-progress-row"
        aria-label={[title, count, detail].filter(Boolean).join(', ')}
        onClick={() => {
          playWalletSound('soft')
          openSetting(JOB_SETTING[job.kind])
        }}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" aria-hidden>
              {JOB_ICONS[job.kind]}
            </span>
          </div>
          {live ? (
            <span className="history-pending-mark" aria-hidden>
              <LoadingSpinner size="sm" />
            </span>
          ) : null}
        </div>
        <div className="history-body history-progress-body">
          <strong className="history-title">{title}</strong>
          <div className="history-progress-block">
            <Progress.Root
              className="history-progress"
              value={job.progress?.value ?? 0}
              max={job.progress?.max ?? 1}
              indeterminate={!job.progress}
            >
              <Progress.Track className="history-progress-track">
                <Progress.Range className="history-progress-range" />
              </Progress.Track>
            </Progress.Root>
            {count ? <span className="history-progress-count">{count}</span> : null}
          </div>
          {detail ? (
            <span className="history-when" title={detail}>
              {detail}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  )
}

