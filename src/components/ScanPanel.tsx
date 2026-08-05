import { clearNavChild, openSendFlow, openSetting } from '../wallet/navStore'
import { tryParsePairPayload } from '../wallet/deviceWallets'
import { setPendingPairScan } from '../wallet/pendingPairScan'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { identityKeyFromScan, QrScanner } from './QrScanner'

/**
 * Dashboard scan — device-link QR → Use on another device; else PeerPay / identity → Send.
 */
export function ScanPanel() {
  return (
    <div className="nav-child-panel scan-panel" data-aeon-scope="scan">
      <QrScanner
        hint="Point at a device-link, PeerPay, identity, or address QR"
        onCancel={() => {
          playWalletSound('soft')
          clearNavChild()
        }}
        onScan={(raw) => {
          const trimmed = raw.trim()
          if (!trimmed) {
            playWalletSound('error')
            toastError('Empty QR', 'Nothing readable in that code.')
            return
          }

          if (tryParsePairPayload(trimmed)) {
            setPendingPairScan(trimmed)
            playWalletSound('soft')
            toastSuccess('Device link QR', 'Confirming on Use on another device…')
            openSetting('device-handoff')
            return
          }

          const value = identityKeyFromScan(trimmed).trim()
          if (!value) {
            playWalletSound('error')
            toastError('Empty QR', 'Nothing readable in that code.')
            return
          }
          playWalletSound('soft')
          openSendFlow(value, { requireBackup: false })
        }}
      />
    </div>
  )
}
