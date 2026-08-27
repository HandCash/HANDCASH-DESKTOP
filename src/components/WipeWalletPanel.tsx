import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { wipeMachine } from '../machines/wipeMachine'
import { wipeAllWalletData } from '../wallet/wipeWallet'
import { playWalletSound } from '../wallet/soundService'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'

const CONFIRM_WORD = 'DELETE'

export function WipeWalletPanel() {
  const [snapshot, send] = useMachine(wipeMachine)
  const stateAttr = stateToAttr(snapshot.value)
  const passwordReady = snapshot.context.unlocked
  const canSubmit =
    passwordReady &&
    snapshot.context.acknowledged &&
    snapshot.context.confirmText.trim().toUpperCase() === CONFIRM_WORD

  const submit = async () => {
    if (!canSubmit || snapshot.matches('wiping')) return
    send({ type: 'SUBMIT' })
    try {
      await wipeAllWalletData(snapshot.context.password || null)
      send({ type: 'SUCCESS' })
      playWalletSound('soft')
      window.location.reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      playWalletSound('error')
    }
  }

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="wipe-wallet"
      data-aeon-state={stateAttr}
    >
      {!passwordReady ? (
        <ConfirmPasswordGate
          id="wipe-password"
          title="Wipe this device"
          lede="Removes the wallet from this device. You’ll need a backup to restore. Confirm with device unlock or your HandCash password."
          actionLabel="Continue"
          onVerified={(password) => send({ type: 'VERIFIED', password })}
        />
      ) : (
        <form
          className="settings-form settings-form-compact"
          data-aeon-part="form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="confirm-password-copy">
            <h3 className="confirm-password-title">Final confirmation</h3>
            <p className="confirm-password-lede">
              This cannot be undone without a backup. Type {CONFIRM_WORD} to continue.
            </p>
          </div>

          <label className="field settings-check-label">
            <input
              type="checkbox"
              checked={snapshot.context.acknowledged}
              disabled={snapshot.matches('wiping')}
              onChange={(e) => send({ type: 'TOGGLE_ACK', acknowledged: e.target.checked })}
            />
            <span>I understand this cannot be undone without my backup.</span>
          </label>

          <div className="field">
            <label htmlFor="wipe-confirm">
              Type <strong>{CONFIRM_WORD}</strong>
            </label>
            <input
              id="wipe-confirm"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={snapshot.context.confirmText}
              disabled={snapshot.matches('wiping')}
              autoFocus
              onChange={(e) => send({ type: 'CHANGE_CONFIRM', confirmText: e.target.value })}
            />
          </div>

          {(snapshot.context.error || snapshot.matches('failure')) && (
            <p className="error" role="alert">
              {snapshot.context.error || 'Wipe failed'}
            </p>
          )}

          <div className="actions">
            <button
              type="submit"
              className="btn btn-danger"
              data-aeon-part="trigger"
              data-aeon-state={stateAttr}
              disabled={!canSubmit || snapshot.matches('wiping')}
            >
              {snapshot.matches('wiping') ? 'Wiping…' : 'Wipe wallet'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={snapshot.matches('wiping')}
              onClick={() => {
                send({ type: 'CHANGE_PASSWORD', password: '' })
                send({ type: 'CHANGE_CONFIRM', confirmText: '' })
                send({ type: 'TOGGLE_ACK', acknowledged: false })
                playWalletSound('soft')
              }}
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
