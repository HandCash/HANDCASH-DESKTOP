import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { PairDevicePanel } from './PairDevicePanel'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

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

      <div className="actions device-backup-more">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            playWalletSound('soft')
            openSetting('backup')
          }}
        >
          Key slices
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            playWalletSound('soft')
            openSetting('history-backup')
          }}
        >
          History backup
        </button>
      </div>

      <SettingsFeatureAbout tags={['BRC-75', 'BRC-140', 'BRC-78']}>
        Each encrypted copy goes one way. It does not share identity, balance, history, or
        day-to-day spending access.
      </SettingsFeatureAbout>
    </div>
  )
}
