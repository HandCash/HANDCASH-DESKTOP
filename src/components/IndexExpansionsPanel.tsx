import { useEffect, useState } from 'react'
import { DeferredImage } from './DeferredImage'
import { SettingsControlRow, SettingsSection } from './settings'
import { listIndexExpansions, removeIndexExpansion } from '../wallet/indexExpansion'
import { playWalletSound } from '../wallet/soundService'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function IndexExpansionsPanel() {
  const [packs, setPacks] = useState(() => listIndexExpansions().packs)

  useEffect(() => {
    const id = window.setInterval(() => {
      setPacks(listIndexExpansions().packs)
    }, 2000)
    return () => window.clearInterval(id)
  }, [])

  const onRemove = (packId: string, name: string) => {
    if (!window.confirm(`Remove cached catalog "${name}"? Held collectables are not affected.`)) {
      return
    }
    playWalletSound('soft')
    removeIndexExpansion({ packId })
    setPacks(listIndexExpansions().packs)
  }

  return (
    <SettingsSection title="Catalog packs" part="index-expansions">
      {packs.length === 0 ? (
        <p className="settings-row-desc">
          No catalog packs installed. Apps can request BRC-230 index expansion installs;
          cached rows are display-only, not custody.
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
      <SettingsControlRow
        label="Developer guide"
        description="docs/bsva/brcs/wallet/index-expansion-guide.md (BRC-230)"
      >
        <span className="settings-row-desc mono">index-expansion-guide.md</span>
      </SettingsControlRow>
    </SettingsSection>
  )
}
