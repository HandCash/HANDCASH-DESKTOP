import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { useEffect, useState } from 'react'
import { unlockMachine } from '../machines/unlockMachine'
import {
  createVault,
  restoreVaultFromMnemonic,
  unlockVault,
  type Chain,
} from '../wallet/vault'
import { bootWallet, fetchBalanceSats } from '../wallet/session'
import { markBackupConfirmed } from '../wallet/backupStatus'
import { playWalletSound } from '../wallet/soundService'
import {
  clearUnlockNudge,
  subscribeUnlockNudge,
} from '../wallet/walletHealth'
import type { WalletProfile } from '../machines/appMachine'

type Props = {
  mode: 'onboarding' | 'locked'
  error: string | null
  /** Toolbox has funds but no vault — create is hidden. */
  recoveryOnly?: boolean
  onCreated: (profile: WalletProfile, balanceSats: number) => void
  onUnlocked: (profile: WalletProfile, balanceSats: number) => void
  onFail: (error: string) => void
}

type FormMode = 'create' | 'restore' | 'unlock'

function isMismatchError(message: string | null | undefined): boolean {
  if (!message) return false
  return (
    message.includes('does not match the funded') ||
    message.includes('missing unlock keys') ||
    message.includes('Restore with your recovery phrase')
  )
}

export function AuthScreen({
  mode,
  error,
  recoveryOnly = false,
  onCreated,
  onUnlocked,
  onFail,
}: Props) {
  const [snapshot, send] = useMachine(unlockMachine)
  const chain: Chain = 'main'
  const stateAttr = stateToAttr(snapshot.value)
  const [formMode, setFormMode] = useState<FormMode>(
    recoveryOnly ? 'restore' : mode === 'locked' ? 'unlock' : 'create',
  )
  const [mnemonicInput, setMnemonicInput] = useState('')
  const [offerRestoreOnLock, setOfferRestoreOnLock] = useState(false)
  const [unlockNudge, setUnlockNudge] = useState(false)

  useEffect(() => {
    if (recoveryOnly) setFormMode('restore')
  }, [recoveryOnly])

  useEffect(() => subscribeUnlockNudge(setUnlockNudge), [])

  useEffect(() => {
    if (mode === 'locked' && isMismatchError(error)) setOfferRestoreOnLock(true)
  }, [mode, error])

  const submit = async () => {
    if (snapshot.context.password.length < 8) {
      onFail('Password must be at least 8 characters')
      return
    }
    const password = snapshot.context.password
    send({ type: 'SUBMIT' })
    try {
      if (formMode === 'restore') {
        const unlocked = await restoreVaultFromMnemonic({
          mnemonic: mnemonicInput,
          password,
          chain,
        })
        const active = await bootWallet({
          rootKeyHex: unlocked.rootKeyHex,
          handle: unlocked.record.handle,
          chain: unlocked.record.chain,
        })
        const balanceSats = await fetchBalanceSats(active.wallet)
        markBackupConfirmed()
        send({ type: 'SUCCESS' })
        playWalletSound('unlock')
        clearUnlockNudge()
        onCreated(
          {
            handle: unlocked.record.handle,
            identityKey: unlocked.record.identityKey,
            address: unlocked.record.address,
            chain: unlocked.record.chain,
          },
          balanceSats,
        )
        return
      }

      if (formMode === 'create') {
        const unlocked = await createVault({ password, chain })
        const active = await bootWallet({
          rootKeyHex: unlocked.rootKeyHex,
          handle: unlocked.record.handle,
          chain: unlocked.record.chain,
        })
        const balanceSats = await fetchBalanceSats(active.wallet)
        send({ type: 'SUCCESS' })
        playWalletSound('unlock')
        clearUnlockNudge()
        onCreated(
          {
            handle: unlocked.record.handle,
            identityKey: unlocked.record.identityKey,
            address: unlocked.record.address,
            chain: unlocked.record.chain,
          },
          balanceSats,
        )
        return
      }

      const unlocked = await unlockVault(password)
      const active = await bootWallet({
        rootKeyHex: unlocked.rootKeyHex,
        handle: unlocked.record.handle,
        chain: unlocked.record.chain,
      })
      const balanceSats = await fetchBalanceSats(active.wallet)
      send({ type: 'SUCCESS' })
      playWalletSound('unlock')
      clearUnlockNudge()
      onUnlocked(
        {
          handle: unlocked.record.handle,
          identityKey: unlocked.record.identityKey,
          address: unlocked.record.address,
          chain: unlocked.record.chain,
        },
        balanceSats,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (mode === 'locked' && isMismatchError(message)) {
        setOfferRestoreOnLock(true)
        setFormMode('restore')
      }
      send({ type: 'FAIL', error: message })
      playWalletSound('error')
      onFail(message)
    }
  }

  const title =
    formMode === 'restore'
      ? 'Restore wallet'
      : formMode === 'create'
        ? 'Create wallet'
        : 'Welcome back'

  const lede =
    formMode === 'restore'
      ? 'Enter your 12-word phrase and choose a password for this device.'
      : formMode === 'create'
        ? 'Pick a password. Your keys stay on this device.'
        : 'Enter your password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel =
    formMode === 'restore' ? 'Restore' : formMode === 'create' ? 'Create' : 'Unlock'

  return (
    <section className="auth-screen" data-aeon-scope="auth" data-aeon-state={stateAttr}>
      <div className="auth-copy">
        <h1 className="auth-title">{title}</h1>
        <p className="auth-lede">{lede}</p>
        {unlockNudge && mode === 'locked' ? (
          <p className="auth-unlock-nudge" role="status">
            An app needs this wallet — unlock to continue.
          </p>
        ) : null}
      </div>

      <form
        className="auth-form"
        data-aeon-part="form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {mode === 'locked' && offerRestoreOnLock ? (
          <div className="auth-mode-switch" role="tablist" aria-label="Wallet access">
            <button
              type="button"
              role="tab"
              aria-selected={formMode === 'unlock'}
              className="auth-mode-tab"
              data-aeon-state={formMode === 'unlock' ? 'selected' : 'idle'}
              onClick={() => setFormMode('unlock')}
            >
              Unlock
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={formMode === 'restore'}
              className="auth-mode-tab"
              data-aeon-state={formMode === 'restore' ? 'selected' : 'idle'}
              onClick={() => setFormMode('restore')}
            >
              Restore
            </button>
          </div>
        ) : null}

        {formMode === 'restore' ? (
          <div className="field" data-aeon-part="field">
            <label htmlFor="mnemonic">Recovery phrase</label>
            <textarea
              id="mnemonic"
              rows={3}
              placeholder="twelve words separated by spaces"
              value={mnemonicInput}
              onChange={(e) => setMnemonicInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
            />
          </div>
        ) : null}

        <div className="field" data-aeon-part="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            placeholder="At least 8 characters"
            value={snapshot.context.password}
            onChange={(e) => send({ type: 'CHANGE', password: e.target.value })}
            autoComplete={formMode === 'unlock' ? 'current-password' : 'new-password'}
            autoFocus={formMode !== 'restore'}
          />
        </div>

        {(error || snapshot.context.error) && (
          <p className="error auth-error" role="alert">
            {error || snapshot.context.error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary auth-submit"
          data-aeon-part="trigger"
          data-aeon-state={stateAttr}
          disabled={submitting}
        >
          {submitting ? 'Working…' : primaryLabel}
        </button>

        {mode === 'onboarding' && !recoveryOnly && formMode === 'create' ? (
          <p className="auth-alt">
            Have a recovery phrase?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('restore')}>
              Restore
            </button>
          </p>
        ) : null}

        {mode === 'onboarding' && !recoveryOnly && formMode === 'restore' ? (
          <p className="auth-alt">
            New here?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('create')}>
              Create a wallet
            </button>
          </p>
        ) : null}
      </form>
    </section>
  )
}
