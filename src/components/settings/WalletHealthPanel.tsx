import { useEffect, useState } from 'react'
import {
  getDependencyHealthSnapshot,
  refreshDependencyHealth,
  subscribeDependencyHealth,
  type DependencyHealthSnapshot,
  type DependencyProbeStatus,
} from '../../wallet/dependencyHealth'
import { playWalletSound } from '../../wallet/soundService'
import { SettingsControlRow } from './SettingsControlRow'

function tone(status: DependencyProbeStatus): 'muted' | 'warn' | 'error' {
  if (status === 'ok') return 'muted'
  if (status === 'degraded') return 'warn'
  return 'error'
}

function statusLabel(status: DependencyProbeStatus): string {
  if (status === 'ok') return 'OK'
  if (status === 'degraded') return 'Slow'
  return 'Down'
}

/** Settings → Wallet health — upstream service probes. */
export function WalletHealthPanel() {
  const [snap, setSnap] = useState<DependencyHealthSnapshot>(() =>
    getDependencyHealthSnapshot(),
  )
  const [checking, setChecking] = useState(false)

  useEffect(() => subscribeDependencyHealth(setSnap), [])

  useEffect(() => {
    let cancelled = false
    setChecking(true)
    void refreshDependencyHealth()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = async () => {
    if (checking) return
    playWalletSound('soft')
    setChecking(true)
    try {
      await refreshDependencyHealth()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="nav-section-body settings-nav" data-aeon-scope="wallet-health">
      <div className="connected-panel-head settings-panel-head">
        <h2>Wallet health</h2>
        <div className="connected-panel-head-actions">
          <button
            type="button"
            className="btn btn-primary settings-action-btn"
            disabled={checking}
            onClick={() => {
              void refresh()
            }}
          >
            {checking ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>

      <ul className="settings-list">
        {snap.probes.map((probe) => (
          <SettingsControlRow
            key={probe.id}
            label={probe.label}
            description={checking && snap.at === 0 ? '…' : probe.detail}
          >
            <span
              className="status-pill status-pill-compact"
              data-tone={tone(probe.status)}
              data-aeon-state={probe.status}
            >
              {statusLabel(probe.status)}
            </span>
          </SettingsControlRow>
        ))}
      </ul>
    </div>
  )
}
