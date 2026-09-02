import { useEffect, useState } from 'react'
import {
  getDependencyHealthSnapshot,
  refreshDependencyHealth,
  subscribeDependencyHealth,
  type DependencyHealthSnapshot,
  type DependencyProbeStatus,
} from '../../wallet/dependencyHealth'
import { playWalletSound } from '../../wallet/soundService'
import {
  formatUtxoHealResult,
  healUtxoFromActivityHistory,
  type UtxoHealFromHistoryResult,
} from '../../wallet/utxoHealFromHistory'
import { SettingsControlRow } from './SettingsControlRow'
import { SettingsSection } from './SettingsSection'

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

/** Settings → Wallet health — upstream service probes + local UTXO heal. */
export function WalletHealthPanel() {
  const [snap, setSnap] = useState<DependencyHealthSnapshot>(() =>
    getDependencyHealthSnapshot(),
  )
  const [checking, setChecking] = useState(false)
  const [healing, setHealing] = useState(false)
  const [healResult, setHealResult] = useState<UtxoHealFromHistoryResult | null>(
    null,
  )
  const [healError, setHealError] = useState<string | null>(null)

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

  const healFromHistory = async () => {
    if (healing) return
    playWalletSound('soft')
    setHealing(true)
    setHealError(null)
    setHealResult(null)
    try {
      const result = await healUtxoFromActivityHistory()
      setHealResult(result)
    } catch (err) {
      setHealError(err instanceof Error ? err.message : String(err))
    } finally {
      setHealing(false)
    }
  }

  const healSummary = healError
    ? healError
    : healResult
      ? formatUtxoHealResult(healResult)
      : 'Scan Activity and session logs for signed sends, then promote stuck change.'

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

      <SettingsSection title="Local recovery" part="utxo-heal">
        <ul className="settings-list">
          <SettingsControlRow
            label="Heal UTXO from history"
            description={healSummary}
          >
            <button
              type="button"
              className="btn btn-secondary settings-action-btn"
              disabled={healing}
              data-aeon-state={healing ? 'running' : healError ? 'failed' : 'idle'}
              onClick={() => {
                void healFromHistory()
              }}
            >
              {healing ? 'Healing…' : 'Heal'}
            </button>
          </SettingsControlRow>
        </ul>
      </SettingsSection>
    </div>
  )
}
