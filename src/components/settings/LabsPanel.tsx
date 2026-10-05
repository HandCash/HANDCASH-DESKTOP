import { Switch } from '@aeon-ui/ui'
import { useLab } from '../../hooks/useLab'
import { LAB_FEATURES, setLabEnabled, type LabFeature } from '../../wallet/labs'
import { playWalletSound } from '../../wallet/soundService'
import { SettingsControlRow } from './SettingsControlRow'

function LabRow({ feature }: { feature: LabFeature }) {
  const enabled = useLab(feature.id)
  return (
    <SettingsControlRow label={feature.label} description={feature.description}>
      <Switch.Root
        checked={enabled}
        aria-label={feature.label}
        data-aeon-part="lab-switch"
        data-aeon-state={enabled ? 'on' : 'off'}
        onCheckedChange={(next) => {
          playWalletSound('soft')
          setLabEnabled(feature.id, next)
        }}
      />
    </SettingsControlRow>
  )
}

/** Settings → Labs. Every feature starts off on this device. */
export function LabsPanel() {
  return (
    <div className="nav-section-body settings-nav" data-aeon-scope="labs">
      <div className="connected-panel-head settings-panel-head">
        <h2>Labs</h2>
      </div>
      <p className="settings-row-desc" data-aeon-part="intro">
        Features still being finished. They are off until you turn them on, and only on this device.
      </p>
      <ul className="settings-list">
        {LAB_FEATURES.map((feature) => (
          <LabRow key={feature.id} feature={feature} />
        ))}
      </ul>
    </div>
  )
}
