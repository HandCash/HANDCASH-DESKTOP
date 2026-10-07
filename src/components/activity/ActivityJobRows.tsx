/** Activity rows for work still in motion, above the composed records. */
import { Progress } from '@aeon-ui/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CollectablesIcon, RefreshIcon } from '../icons'
import { LoadingSpinner } from '../LoadingSpinner'
import { openSetting } from '../../wallet/navStore'
import type { PhraseItemMigrateCursor } from '../../wallet/phraseSweep'
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
  'balance-heal': <RefreshIcon size={18} />,
}

const JOB_SETTING: Readonly<Record<WalletJobKind, 'import' | 'wallet-health'>> = {
  'item-import': 'import',
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

/** One long wallet job — an import run, a balance heal — as a single row with a bar. */
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

/** A batch phrase import that stopped part-way, waiting on the user. */
export function PendingPhraseImportRow({ cursor }: { cursor: PhraseItemMigrateCursor }) {
  const skipped = Math.max(0, Math.trunc(cursor.skipped ?? 0))
  const failed = Math.max(0, Math.trunc(cursor.failed))
  const moved = Math.max(0, Math.trunc(cursor.moved))
  const detail = [
    `${moved.toLocaleString()} imported`,
    `${Math.max(0, Math.trunc(cursor.offset)).toLocaleString()} scanned`,
    failed > 0 ? `${failed.toLocaleString()} failed` : null,
    skipped > 0 ? `${skipped.toLocaleString()} skipped` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const status = cursor.stopped === 'funds' ? 'Paused — add BSV to continue' : 'Paused — review details'

  return (
    <li
      data-aeon-scope="phrase-import"
      data-aeon-state="paused"
      data-activity-key={`phrase-import:${cursor.sourceAddress}`}
      data-activity-pending=""
    >
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          playWalletSound('soft')
          openSetting('import')
        }}
        aria-label={`Review paused collectable import, ${detail}`}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" aria-hidden>
              <CollectablesIcon size={18} />
            </span>
          </div>
          <span className="history-pending-mark" aria-label="Import paused" title="Import paused safely">
            <LoadingSpinner size="sm" />
          </span>
        </div>
        <div className="history-body">
          <strong className="history-title">Collectable import paused</strong>
          <span className="history-when" title={`${status}. ${detail}`}>
            {status} · {detail}
          </span>
        </div>
        <div className="history-amount-block">
          <span className="history-amount history-amount-item">Review</span>
        </div>
      </button>
    </li>
  )
}
