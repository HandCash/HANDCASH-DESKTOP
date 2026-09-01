import { useEffect, useState } from 'react'
import {
  getDependencyHealthSnapshot,
  refreshDependencyHealth,
  subscribeDependencyHealth,
  type DependencyHealthSnapshot,
} from '../../wallet/dependencyHealth'
import { SettingsControlRow } from './SettingsControlRow'

function tone(status: string): 'muted' | 'warn' | 'error' {
  if (status === 'ok') return 'muted'
  if (status === 'degraded') return 'warn'
  return 'error'
}

/** Live upstream probe rows for Settings → Support. */
export function SettingsNetworkHealth() {
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

  return (
    <>
      {snap.probes.map((probe) => (
        <SettingsControlRow
          key={probe.id}
          label={probe.label}
          description={
            checking && snap.at === 0
              ? 'Checking…'
              : `${probe.detail}${probe.latencyMs != null ? '' : ''}`
          }
        >
          <span className="status-pill" data-tone={tone(probe.status)} data-aeon-state={probe.status}>
            {probe.status}
          </span>
        </SettingsControlRow>
      ))}
    </>
  )
}
