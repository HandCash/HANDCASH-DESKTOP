import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { readVaultMeta } from '../wallet/vault'
import { PairDevicePanel } from './PairDevicePanel'

/**
 * BRC-75 / BRC-140 → same identity → one pot.
 * Multi-device parity requires the same BRC-39 History backup URL on every install.
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
        Restore with <span className="spec-tag">BRC-75</span> /{' '}
        <span className="spec-tag">BRC-140</span> for the same identity and BSV pot. To keep
        history and friends aligned across devices, set the <strong>same History backup URL</strong>{' '}
        (<span className="spec-tag">BRC-39</span>) on each install — linking will not work without
        it.
      </p>

      <ol className="settings-hint" style={{ marginTop: 12, paddingLeft: '1.25rem' }}>
        <li>Restore the same phrase/shares on the other device.</li>
        <li>Set the identical History backup URL on both (below or History settings).</li>
        <li>Link via QR / paste (URL must match).</li>
        <li>Tap Sync via backup URL (same unlock password) so BRC-39 + friends merge.</li>
        <li>Refresh still reconciles spends against the chain. Offline payments are not supported.</li>
      </ol>

      <div className="actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={openKeys}>
          {hasPhrase ? 'Open Keys (phrase or slices)' : 'Open Keys (BRC-140 slices)'}
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
    </div>
  )
}
