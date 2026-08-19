import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { PairDevicePanel } from './PairDevicePanel'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

/**
 * Multi-device: optional directional key recovery without identity linking.
 * Each device keeps its own spend keys; at most one side holds a cold spare.
 */
export function DeviceHandoffPanel() {
  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="device-handoff">
      <p className="settings-hint">
        Give one wallet a sealed recovery copy on the other device. One direction only.
      </p>

      <PairDevicePanel />

      <div className="actions device-backup-links">
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
        A backup device is only a name and a public key to seal a recovery copy to. It shares no
        identity, balance, history, or spending authority, and never both directions at once.
      </SettingsFeatureAbout>
    </div>
  )
}
