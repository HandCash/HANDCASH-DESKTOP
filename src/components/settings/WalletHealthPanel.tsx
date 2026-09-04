import { useEffect, useState } from 'react'
import {
  getDependencyHealthSnapshot,
  refreshDependencyHealth,
  subscribeDependencyHealth,
  type DependencyHealthSnapshot,
  type DependencyProbeStatus,
} from '../../wallet/dependencyHealth'
import { playWalletSound } from '../../wallet/soundService'
import { toastError, toastSuccess } from '../../wallet/toast'
import {
  healCheckpointAgeMs,
  healCheckpointFresh,
  readHealCheckpoint,
} from '../../wallet/utxoHealCheckpoint'
import {
  formatUtxoHealResult,
  healUtxoFromActivityHistory,
  isUtxoHealRunning,
} from '../../wallet/utxoHealFromHistory'
import { SETTINGS_APPLICATION_ICONS } from './settingIcons'
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

function formatAgeShort(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000)
  const mins = Math.floor((ageMs % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function healRowDescription(): string {
  const cp = readHealCheckpoint()
  if (!cp) return 'Promotes stuck change from Activity and session logs.'
  const age = healCheckpointAgeMs()
  if (age == null) return 'Promotes stuck change from Activity and session logs.'
  const ago = formatAgeShort(age)
  if (healCheckpointFresh()) {
    const rec =
      cp.recoveredSats > 0 ? ` · +${cp.recoveredSats.toLocaleString()} sats` : ''
    return `Healed ${ago}${rec}`
  }
  if (cp.pendingChangeAfter > 0) {
    return `${cp.pendingChangeAfter.toLocaleString()} sats still pending · last pass ${ago}`
  }
  return `Last heal ${ago}`
}

function healRowStatus(): { label: string; tone: 'muted' | 'warn' | 'error' } {
  const cp = readHealCheckpoint()
  if (!cp) return { label: '—', tone: 'muted' }
  if (healCheckpointFresh()) return { label: 'OK', tone: 'muted' }
  if (cp.pendingChangeAfter > 0) return { label: 'Pending', tone: 'warn' }
  return { label: 'Stale', tone: 'warn' }
}

/** Settings → Wallet health — upstream service probes + local UTXO heal. */
export function WalletHealthPanel() {
  const [snap, setSnap] = useState<DependencyHealthSnapshot>(() =>
    getDependencyHealthSnapshot(),
  )
  const [checking, setChecking] = useState(false)
  const [healing, setHealing] = useState(() => isUtxoHealRunning())
  const [healHint, setHealHint] = useState(healRowDescription)
  const healStatus = healRowStatus()

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
    if (healing || isUtxoHealRunning()) return
    playWalletSound('soft')
    setHealing(true)
    try {
      const result = await healUtxoFromActivityHistory()
      setHealHint(healRowDescription())
      const summary = formatUtxoHealResult(result)
      if (result.recoveredSats > 0) {
        toastSuccess('Balance healed', summary)
        playWalletSound('receive')
      } else {
        toastSuccess('Heal complete', summary)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toastError('Heal failed', message)
      playWalletSound('error')
    } finally {
      setHealing(false)
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

      <SettingsSection title="Local recovery" part="utxo-heal">
        <ul className="settings-list">
          <SettingsControlRow
            icon={SETTINGS_APPLICATION_ICONS.updates}
            label="Heal balance from history"
            description={healing ? 'Healing…' : healHint}
          >
            <span
              className="status-pill status-pill-compact"
              data-tone={healing ? 'warn' : healStatus.tone}
              data-aeon-state={healing ? 'running' : healStatus.label.toLowerCase()}
            >
              {healing ? '…' : healStatus.label}
            </span>
            <button
              type="button"
              className="btn btn-primary settings-action-btn"
              disabled={healing}
              data-aeon-state={healing ? 'running' : 'idle'}
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
