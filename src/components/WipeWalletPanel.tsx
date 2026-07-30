import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { wipeMachine } from '../machines/wipeMachine'
import { wipeAllWalletData } from '../wallet/wipeWallet'

const CONFIRM_WORD = 'DELETE'

export function WipeWalletPanel() {
  const [snapshot, send] = useMachine(wipeMachine)
  const stateAttr = stateToAttr(snapshot.value)
  const canSubmit =
    snapshot.context.password.length >= 8 &&
    snapshot.context.acknowledged &&
    snapshot.context.confirmText.trim().toUpperCase() === CONFIRM_WORD

  const submit = async () => {
    if (!canSubmit || snapshot.matches('wiping')) return
    send({ type: 'SUBMIT' })
    try {
      await wipeAllWalletData(snapshot.context.password)
      send({ type: 'SUCCESS' })
      window.location.reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
    }
  }

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="wipe-wallet"
      data-aeon-state={stateAttr}
    >
      <p className="settings-hint">
        Deletes keys and local wallet data on this device. Needs your recovery phrase to restore.
      </p>

      <form
        className="settings-form settings-form-compact"
        data-aeon-part="form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="field">
          <label htmlFor="wipe-password">Password</label>
          <input
            id="wipe-password"
            type="password"
            autoComplete="current-password"
            value={snapshot.context.password}
            disabled={snapshot.matches('wiping')}
            onChange={(e) => send({ type: 'CHANGE_PASSWORD', password: e.target.value })}
          />
        </div>

        <label className="field settings-check-label">
          <input
            type="checkbox"
            checked={snapshot.context.acknowledged}
            disabled={snapshot.matches('wiping')}
            onChange={(e) => send({ type: 'TOGGLE_ACK', acknowledged: e.target.checked })}
          />
          <span>I understand this cannot be undone without my recovery phrase.</span>
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
            {snapshot.matches('wiping') ? 'Wiping…' : 'Wipe wallet data'}
          </button>
        </div>
      </form>
    </div>
  )
}
