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

  useEffect(() => {
    if (recoveryOnly) setFormMode('restore')
  }, [recoveryOnly])

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
      onFail(message)
    }
  }

  const title =
    formMode === 'restore'
      ? 'Recover access.'
      : formMode === 'create'
        ? 'Own your cash.'
        : 'Unlock HandCash.'

  const subtitle =
    formMode === 'restore'
      ? 'Restore wallet'
      : formMode === 'create'
        ? 'Create your wallet'
        : 'Welcome back'

  const lede =
    formMode === 'restore'
      ? 'Enter your recovery phrase and a new unlock password.'
      : formMode === 'create'
        ? 'Your money stays on this device.'
        : 'Enter your password to open your wallet.'

  return (
    <section className="hero-panel" data-aeon-scope="auth" data-aeon-state={stateAttr}>
      <div>
        <p className="brand-sub" style={{ marginBottom: 10 }}>
          {subtitle}
        </p>
        <h1 className="display">{title}</h1>
        <p className="lede" style={{ marginTop: 14 }}>
          {lede}
        </p>
      </div>

      <div className="panel" data-aeon-part="form">
        {mode === 'onboarding' && !recoveryOnly ? (
          <div className="actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`btn ${formMode === 'create' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFormMode('create')}
            >
              Create
            </button>
            <button
              type="button"
              className={`btn ${formMode === 'restore' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFormMode('restore')}
            >
              Restore
            </button>
          </div>
        ) : null}

        {mode === 'locked' && offerRestoreOnLock ? (
          <div className="actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`btn ${formMode === 'unlock' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFormMode('unlock')}
            >
              Unlock
            </button>
            <button
              type="button"
              className={`btn ${formMode === 'restore' ? 'btn-primary' : 'btn-ghost'}`}
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
              placeholder="words separated by spaces"
              value={mnemonicInput}
              onChange={(e) => setMnemonicInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            autoComplete={formMode === 'unlock' ? 'current-password' : 'new-password'}
          />
        </div>

        {(error || snapshot.context.error) && (
          <p className="error" role="alert">
            {error || snapshot.context.error}
          </p>
        )}

        <div className="actions">
          <button
            className="btn btn-primary"
            data-aeon-part="trigger"
            data-aeon-state={stateAttr}
            disabled={snapshot.matches('submitting')}
            onClick={() => void submit()}
          >
            {snapshot.matches('submitting')
              ? 'Working…'
              : formMode === 'restore'
                ? 'Restore wallet'
                : formMode === 'create'
                  ? 'Create wallet'
                  : 'Unlock'}
          </button>
        </div>
      </div>
    </section>
  )
}
