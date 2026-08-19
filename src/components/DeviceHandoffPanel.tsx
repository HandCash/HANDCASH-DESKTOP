import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { readVaultMeta } from '../wallet/vault'
import { PairDevicePanel } from './PairDevicePanel'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

/**
 * Multi-device: link identities + sealed mutual key backups.
 * Each device keeps its own spend keys; the other holds a cold spare.
 */
export function DeviceHandoffPanel() {
  const meta = readVaultMeta()
  const hasPhrase = Boolean(meta?.hasMnemonic)

  const openKeys = () => {
    playWalletSound('soft')
    openSetting('backup')
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="device-handoff"
    >
      <p className="settings-hint">
        Two installs can be <strong>linked identities</strong> with different keys. Each device
        spends only its own coins. Exchange <strong>sealed spares both ways</strong> (cold — not
        used for day-to-day spend). Lose a phone → Recover on the survivor → restore that phrase on
        a new device.
      </p>

      <ol className="settings-hint" style={{ marginTop: 12, paddingLeft: '1.25rem' }}>
        <li>On each device create or restore its own wallet (own phrase).</li>
        <li>
          Show the link QR on one; on the other tap <strong>Scan to link</strong> (or Dashboard
          Scan).
        </li>
        <li>
          Exchange sealed spares (password seals your keys to their identity pubkey —
          do this <strong>both ways</strong>).
        </li>
        <li>
          Optional: still back up <strong>key slices / phrase</strong> offline for each device.
        </li>
      </ol>

      <div className="actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={openKeys}>
          {hasPhrase ? 'Open key slices (or phrase)' : 'Open key slices'}
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

      <div style={{ margin: '20px 0', borderTop: '1px solid hsl(var(--border))' }} />

      <PairDevicePanel />

      <SettingsFeatureAbout tags={['BRC-75', 'BRC-140', 'BRC-78']}>
        Identity link and sealed spare are separate contracts. History backup is optional recovery
        of this device’s local state — not required to link.
      </SettingsFeatureAbout>
    </div>
  )
}
