import { useEffect, useState } from 'react'
import { DeferredImage } from '../DeferredImage'
import {
  listStoredIndexPacks,
  removeIndexExpansion,
} from '../../wallet/indexExpansion'
import { subscribeIndexExpansionPacks } from '../../wallet/indexExpansionStore'
import {
  getWalletProgress,
  subscribeWalletProgress,
  walletProgressDetail,
  walletProgressPercent,
  type WalletProgress,
} from '../../wallet/walletProgress'
import { playWalletSound } from '../../wallet/soundService'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function packStatusLabel(status: string, partial?: boolean): string {
  if (status === 'installing') return 'Installing…'
  if (status === 'ready') return partial ? 'Ready (partial)' : 'Ready'
  if (status === 'partial') return 'Partial cache'
  if (status === 'failed') return 'Failed'
  return status
}

/** Settings → Index packs — all cached BRC-230 catalogs with live install progress. */
export function IndexPacksSettingsPanel() {
  const [packs, setPacks] = useState(() => listStoredIndexPacks())
  const [progress, setProgress] = useState<WalletProgress>(() => getWalletProgress())

  useEffect(() => subscribeIndexExpansionPacks(() => setPacks(listStoredIndexPacks())), [])
  useEffect(() => subscribeWalletProgress(setProgress), [])

  const onRemove = (packId: string, name: string) => {
    if (!window.confirm(`Remove cached catalog "${name}"? Held collectables are not affected.`)) {
      return
    }
    playWalletSound('soft')
    removeIndexExpansion({ packId })
    setPacks(listStoredIndexPacks())
  }

  const installing = progress.kind === 'index-expansion' && progress.status === 'running'
  const pct = walletProgressPercent(progress)
  const progressLine = installing ? walletProgressDetail(progress) : null

  return (
    <div className="nav-section-body settings-nav" data-aeon-scope="index-packs">
      <div className="connected-panel-head settings-panel-head">
        <h2>Index packs</h2>
      </div>

      {installing ? (
        <div className="index-packs-progress settings-row-desc" data-aeon-state="running">
          <strong>{progress.message ?? 'Downloading catalog…'}</strong>
          {progressLine ? <span>{progressLine}</span> : null}
          {pct != null ? (
            <div className="wallet-progress-bar" role="progressbar" aria-valuenow={pct}>
              <div className="wallet-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      {packs.length === 0 ? (
        <p className="settings-row-desc">
          No catalog packs cached yet. When a connected app requests a BRC-230 index
          expansion install, progress appears here and in Activity — display-only, not
          custody.
        </p>
      ) : (
        <ul className="index-expansion-list settings-list">
          {packs.map((pack) => (
            <li key={pack.packId} className="index-expansion-row connected-app-row">
              {pack.iconUrl ? (
                <DeferredImage
                  src={pack.iconUrl}
                  alt=""
                  className="index-expansion-icon app-avatar-sm"
                />
              ) : null}
              <div className="index-expansion-body connected-app-body">
                <strong className="connected-app-name">{pack.name}</strong>
                <span className="connected-app-host mono">{pack.packId}</span>
                <span className="index-expansion-meta settings-row-desc">
                  {pack.entryCount} entries · {formatBytes(pack.bytesUsed)} ·{' '}
                  {packStatusLabel(pack.status, pack.partial)}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary index-expansion-remove"
                onClick={() => onRemove(pack.packId, pack.name)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
