import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { readVaultMeta } from '../wallet/vault'
import { PairDevicePanel } from './PairDevicePanel'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

/**
 * Same identity → one pot; shared history URL for multi-device parity.
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
        On the new device choose <strong>Restore → Cloud</strong> and pull slices from HandCash /
        Haste (same deposit email), or paste your offline slice — any two restore the same identity
        and BSV pot. Phrase and pasted Shares still work. To keep history and friends aligned, set
        the <strong>same History backup URL</strong> on each install.
      </p>

      <ol className="settings-hint" style={{ marginTop: 12, paddingLeft: '1.25rem' }}>
        <li>
          On the new device: Restore → Cloud (trustholders) or Phrase / Shares.
        </li>
        <li>Confirm the identical History backup URL on both.</li>
        <li>
          On one device show the link QR; on the other tap <strong>Scan to link</strong> (or use
          Dashboard Scan).
        </li>
        <li>Tap Sync via backup URL (same unlock password) so history + friends merge.</li>
        <li>Spends reconcile against the chain automatically. Offline payments are not supported.</li>
      </ol>

      <div className="actions" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            playWalletSound('soft')
            openSetting('trustholder-backup')
          }}
        >
          Cloud key backup
        </button>
        <button type="button" className="btn btn-ghost" onClick={openKeys}>
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

      <SettingsFeatureAbout tags={['BRC-75', 'BRC-140', 'BRC-39']}>
        Phrase, Cloud key backup (trustholders), and key slices recover identity. Shared history
        backup URL keeps device state aligned after you sync.
      </SettingsFeatureAbout>
    </div>
  )
}
