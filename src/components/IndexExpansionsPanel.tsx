import { useEffect, useState } from 'react'
import { DeferredImage } from './DeferredImage'
import {
  listIndexPacksForOrigin,
  removeIndexExpansion,
} from '../wallet/indexExpansion'
import { subscribeIndexExpansionPacks } from '../wallet/indexExpansionStore'
import { playWalletSound } from '../wallet/soundService'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Catalog packs installed for one connected app — lives under App details, not Settings. */
export function AppCatalogPacksPanel({ origin }: { origin: string }) {
  const [packs, setPacks] = useState(() => listIndexPacksForOrigin(origin))

  useEffect(() => {
    return subscribeIndexExpansionPacks(() => {
      setPacks(listIndexPacksForOrigin(origin))
    })
  }, [origin])

  const onRemove = (packId: string, name: string) => {
    if (!window.confirm(`Remove cached catalog "${name}"? Held collectables are not affected.`)) {
      return
    }
    playWalletSound('soft')
    removeIndexExpansion({ packId })
    setPacks(listIndexPacksForOrigin(origin))
  }

  return (
    <div className="app-details-section" data-aeon-part="index-expansions">
      <p className="scope-list-label">Catalog packs</p>
      {packs.length === 0 ? (
        <p className="settings-row-desc">
          No catalog packs for this app yet. When the app requests a BRC-230 index
          expansion install, cached rows appear here — display-only, not custody.
        </p>
      ) : (
        <ul className="index-expansion-list">
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
                  {pack.entryCount} entries · {formatBytes(pack.bytesUsed)} · {pack.status}
                  {pack.partial ? ' (partial)' : ''}
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
