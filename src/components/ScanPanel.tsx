import { useState } from 'react'
import { clearNavChild, openAddFriend, openSendFlow, openSetting } from '../wallet/navStore'
import { tryParsePairPayload } from '../wallet/deviceWallets'
import { setPendingPairScan } from '../wallet/pendingPairScan'
import { tryParseBrc29SettlementUri } from '../wallet/brc29Uri'
import { claimBrc29SettlementUri } from '../wallet/sendBrc29Payment'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { identityKeyFromScan, QrScanner } from './QrScanner'

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

/**
 * Dashboard scan — device-link QR → Use on another device;
 * else choose Add friend (identity keys) or Send.
 */
export function ScanPanel() {
  const [pending, setPending] = useState<PendingScan | null>(null)

  if (pending) {
    const short =
      pending.identityKey != null
        ? `${pending.identityKey.slice(0, 10)}…${pending.identityKey.slice(-8)}`
        : pending.sendValue.length > 28
          ? `${pending.sendValue.slice(0, 12)}…${pending.sendValue.slice(-8)}`
          : pending.sendValue

    return (
      <div
        className="nav-child-panel scan-panel scan-choice"
        data-aeon-scope="scan"
        data-aeon-state="choice"
      >
        <p className="scan-choice-label">Scanned</p>
        <p className="mono scan-choice-value" title={pending.sendValue}>
          {short}
        </p>
        <div className="actions scan-choice-actions">
          {pending.identityKey ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                playWalletSound('soft')
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              playWalletSound('soft')
              clearNavChild()
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="nav-child-panel scan-panel" data-aeon-scope="scan">
      <QrScanner
        hint="Point at a device-link, PeerPay, remittance, identity, or address QR"
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

          if (tryParseBrc29SettlementUri(trimmed)) {
            void (async () => {
              try {
                const result = await claimBrc29SettlementUri(trimmed)
                if (result.accepted) {
                  playWalletSound('soft')
                  toastSuccess('Payment claimed', 'BRC-29 remittance internalized (SPV)')
                  clearNavChild()
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
