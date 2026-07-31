import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { useEffect, useState } from 'react'
import { unlockMachine } from '../machines/unlockMachine'
import {
  createVault,
  restoreVaultFromMnemonic,
  restoreVaultFromRootKey,
  unlockVault,
  type Chain,
} from '../wallet/vault'
import { bootWallet, fetchBalanceSats } from '../wallet/session'
import { markBackupConfirmed } from '../wallet/backupStatus'
import { recoverRootKeyFromBrc140Shares } from '../wallet/brc140Backup'
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

type FormMode = 'create' | 'restore' | 'restore-shares' | 'unlock'

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
  const [share1, setShare1] = useState('')
  const [share2, setShare2] = useState('')
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

      if (formMode === 'restore-shares') {
        const recovered = recoverRootKeyFromBrc140Shares([share1, share2])
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: recovered.rootKeyHex,
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
    formMode === 'restore' || formMode === 'restore-shares'
      ? 'Restore wallet'
      : formMode === 'create'
        ? 'Create wallet'
        : 'Welcome back'

  const lede =
    formMode === 'restore'
      ? 'Enter your 12-word phrase and choose a password for this device.'
      : formMode === 'restore-shares'
        ? 'Paste any two BRC-140 shares and choose a password for this device.'
        : formMode === 'create'
          ? 'Pick a password. Your keys stay on this device.'
          : 'Enter your password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel =
    formMode === 'restore' || formMode === 'restore-shares'
      ? 'Restore'
      : formMode === 'create'
        ? 'Create'
        : 'Unlock'

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

        {formMode === 'restore-shares' ? (
          <>
            <div className="field" data-aeon-part="field">
              <label htmlFor="share1">BRC-140 share 1</label>
              <textarea
                id="share1"
                rows={2}
                placeholder="x.y.2.integrity…"
                value={share1}
                onChange={(e) => setShare1(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="field" data-aeon-part="field">
              <label htmlFor="share2">BRC-140 share 2</label>
              <textarea
                id="share2"
                rows={2}
                placeholder="x.y.2.integrity…"
                value={share2}
                onChange={(e) => setShare2(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </>
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
            autoFocus={formMode === 'unlock' || formMode === 'create'}
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
            {' · '}
            <button
              type="button"
              className="auth-alt-link"
              onClick={() => setFormMode('restore-shares')}
            >
              Split shares
            </button>
          </p>
        ) : null}

        {mode === 'onboarding' &&
        !recoveryOnly &&
        (formMode === 'restore' || formMode === 'restore-shares') ? (
          <p className="auth-alt">
            New here?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('create')}>
              Create a wallet
            </button>
            {formMode === 'restore' ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="auth-alt-link"
                  onClick={() => setFormMode('restore-shares')}
                >
                  Use split shares
                </button>
              </>
            ) : (
              <>
                {' · '}
                <button
                  type="button"
                  className="auth-alt-link"
                  onClick={() => setFormMode('restore')}
                >
                  Use recovery phrase
                </button>
              </>
            )}
          </p>
        ) : null}
      </form>
    </section>
  )
}
