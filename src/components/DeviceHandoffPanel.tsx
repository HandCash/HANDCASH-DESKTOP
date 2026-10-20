import { openSetting } from '../wallet/navStore'
import { PairDevicePanel } from './PairDevicePanel'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'
import { SettingsNavRow, SettingsSection, settingIconFor } from './settings'

/**
 * Multi-device: optional one-way key recovery between two separate wallets.
 * Each device keeps its own spend keys; at most one side holds a cold copy.
 */
export function DeviceHandoffPanel() {
  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="device-handoff">
      <p className="settings-hint">
        Link another device, then keep an encrypted copy of one wallet on the other. It
        travels one way only.
      </p>

      <PairDevicePanel />

      <SettingsSection title="Related" part="related">
        <ul className="settings-list">
          <SettingsNavRow
            label="Key slices"
            description="Split recovery across people and places"
            icon={settingIconFor('backup').icon}
            onClick={() => openSetting('backup')}
          />
          <SettingsNavRow
            label="History backup"
            description="Encrypted copy of payments and labels"
            icon={settingIconFor('history-backup').icon}
            onClick={() => openSetting('history-backup')}
          />
        </ul>
      </SettingsSection>

      <SettingsFeatureAbout tags={['BRC-157', 'BRC-75', 'BRC-140', 'BRC-78']}>
        Each encrypted copy goes one way. It does not share identity, balance, history, or
        day-to-day spending access.
      </SettingsFeatureAbout>
    </div>
  )
}
