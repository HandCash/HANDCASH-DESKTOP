import { clearNavChild, openSendFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError } from '../wallet/toast'
import { identityKeyFromScan, QrScanner } from './QrScanner'

/**
 * Dashboard scan — PeerPay / identity / address QR → Send with recipient filled.
 */
export function ScanPanel() {
  return (
    <div className="nav-child-panel scan-panel" data-aeon-scope="scan">
      <QrScanner
        hint="Point at a PeerPay, identity, or address QR"
        onCancel={() => {
          playWalletSound('soft')
          clearNavChild()
        }}
        onScan={(raw) => {
          const value = identityKeyFromScan(raw).trim()
          if (!value) {
            playWalletSound('error')
            toastError('Empty QR', 'Nothing readable in that code.')
            return
          }
          playWalletSound('soft')
          openSendFlow(value)
        }}
      />
    </div>
  )
}
