import { useState } from 'react'
import { clearNavChild, closeSideScan, openAddFriend, openSendFlow, openSetting } from '../wallet/navStore'
import { tryParsePairPayload } from '../wallet/deviceWallets'
import { tryParseDeviceKeyBackupPackage } from '../wallet/deviceKeyBackup'
import { setPendingPairScan } from '../wallet/pendingPairScan'
import { tryParseBrc29SettlementUri } from '../wallet/brc29Uri'
import { claimBrc29SettlementUri } from '../wallet/sendBrc29Payment'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { identityKeyFromScan, QrScanner } from './QrScanner'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'

const IDENTITY_KEY_RE = /^(02|03)[0-9a-fA-F]{64}$|^04[0-9a-fA-F]{128}$/

function isIdentityKey(value: string): boolean {
  return IDENTITY_KEY_RE.test(value.trim())
}

type PendingScan = {
  /** Value to prefill Send (identity key, address, peerpay, etc.). */
  sendValue: string
  /** When set, Add friend is offered with this key. */
  identityKey: string | null
}

type Props = {
  /**
   * `side` — fills the dashboard BSV price slot (desktop).
   * `nav` — classic nav-child panel (phone / narrow).
   */
  placement?: 'side' | 'nav'
}

/**
 * Dashboard scan — device code QR → Device backup;
 * else choose Add friend (identity keys) or Send.
 */
export function ScanPanel({ placement = 'nav' }: Props) {
  const [pending, setPending] = useState<PendingScan | null>(null)
  const side = placement === 'side'

  const dismiss = () => {
    if (side) closeSideScan()
    else clearNavChild()
  }

  const close = () => {
    playWalletSound('soft')
    releaseWarmedQrCamera()
    dismiss()
  }

  if (pending) {
    const short =
      pending.identityKey != null
        ? `${pending.identityKey.slice(0, 10)}…${pending.identityKey.slice(-8)}`
        : pending.sendValue.length > 28
          ? `${pending.sendValue.slice(0, 12)}…${pending.sendValue.slice(-8)}`
          : pending.sendValue

    return (
      <div
        className={
          side
            ? 'panel scan-side-panel scan-choice'
            : 'nav-child-panel scan-panel scan-choice'
        }
        data-aeon-scope="scan"
        data-aeon-state="choice"
      >
        {side ? (
          <header className="scan-side-header">
            <h2 className="scan-side-title">Scan</h2>
            <button type="button" className="btn btn-ghost scan-side-close" onClick={close}>
              Close
            </button>
          </header>
        ) : null}
        <div className="scan-choice-body">
          <p className="scan-choice-value" title={pending.sendValue}>
            {short}
          </p>
          <div className="actions scan-choice-actions">
          {pending.identityKey ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                playWalletSound('soft')
                dismiss()
                openAddFriend({ identityKey: pending.identityKey! })
              }}
            >
              Add as friend
            </button>
          ) : null}
          <button
            type="button"
            className={pending.identityKey ? 'btn btn-ghost' : 'btn btn-primary'}
            onClick={() => {
              playWalletSound('soft')
              dismiss()
              openSendFlow(pending.sendValue)
            }}
          >
            Send
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              playWalletSound('soft')
              setPending(null)
            }}
          >
            Scan again
          </button>
          {!side ? (
            <button type="button" className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
          ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={side ? 'panel scan-side-panel' : 'nav-child-panel scan-panel'}
      data-aeon-scope="scan"
      data-aeon-state="scanning"
    >
      {side ? (
        <header className="scan-side-header">
          <h2 className="scan-side-title">Scan</h2>
          <button type="button" className="btn btn-ghost scan-side-close" onClick={close}>
            Close
          </button>
        </header>
      ) : null}
      <QrScanner
        layout={side ? 'fill' : 'default'}
        hint="Point your camera at a QR code"
        onCancel={close}
        onScan={(raw) => {
          const trimmed = raw.trim()
          if (!trimmed) {
            playWalletSound('error')
            toastError('Empty QR', 'Nothing readable in that code.')
            return
          }

          const pair = tryParsePairPayload(trimmed)
          const spare = tryParseDeviceKeyBackupPackage(trimmed)
          if (pair || spare) {
            setPendingPairScan(trimmed)
            playWalletSound('soft')
            toastSuccess(
              spare ? 'Sealed recovery QR' : 'Device code',
              'Confirming in Device backup…',
            )
            dismiss()
            openSetting('device-handoff')
            return
          }

          if (tryParseBrc29SettlementUri(trimmed)) {
            void (async () => {
              try {
                const result = await claimBrc29SettlementUri(trimmed)
                if (result.accepted) {
                  playWalletSound('soft')
                  toastSuccess('Payment claimed', 'BRC-29 remittance internalized (SPV)')
                  dismiss()
                  return
                }
                playWalletSound('error')
                toastError(
                  'Claim failed',
                  result.reason || 'Could not credit that remittance QR',
                )
              } catch (err) {
                playWalletSound('error')
                toastError(
                  'Claim failed',
                  err instanceof Error ? err.message : String(err),
                )
              }
            })()
            return
          }

          const value = identityKeyFromScan(trimmed).trim()
          if (!value) {
            playWalletSound('error')
            toastError('Empty QR', 'Nothing readable in that code.')
            return
          }
          playWalletSound('soft')
          setPending({
            sendValue: value,
            identityKey: isIdentityKey(value) ? value : null,
          })
        }}
      />
    </div>
  )
}
