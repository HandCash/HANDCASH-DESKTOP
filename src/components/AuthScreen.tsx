import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { useEffect, useRef, useState } from 'react'
import { unlockMachine } from '../machines/unlockMachine'
import {
  createVault,
  restoreVaultFromMnemonic,
  restoreVaultFromRootKey,
  unlockVault,
  type Chain,
  type UnlockedVault,
} from '../wallet/vault'
import { bootWallet, fetchBalanceSats } from '../wallet/session'
import { syncLegacyFunds } from '../wallet/syncFunds'
import { UNLOCK_PASSWORD_MIN_LENGTH, validatePassword } from '../wallet/passwordPolicy'
import { recoverRootKeyFromBrc140Shares } from '../wallet/brc140Backup'
import { playWalletSound } from '../wallet/soundService'
import {
  clearUnlockNudge,
  subscribeUnlockNudge,
} from '../wallet/walletHealth'
import type { WalletProfile } from '../machines/appMachine'
import { getWalletConfigPrefs } from '../wallet/walletConfig'
import { WalletSetupConfigPanel } from './WalletSetupConfigPanel'

type Props = {
  mode: 'onboarding' | 'locked'
  error: string | null
  /** Toolbox has funds but no vault — create is hidden. */
  recoveryOnly?: boolean
  onCreated: (profile: WalletProfile, balanceSats: number) => void
  onUnlocked: (profile: WalletProfile, balanceSats: number) => void
  onFail: (error: string) => void
}

/** Custody restore paths the vault can bootstrap from. */
type RestoreMethod = 'phrase' | 'shares' | 'key'
type FormMode = 'create' | 'unlock' | RestoreMethod

const RESTORE_METHODS: { id: RestoreMethod; label: string }[] = [
  { id: 'phrase', label: 'Phrase' },
  { id: 'shares', label: 'Shares' },
  { id: 'key', label: 'Key' },
]

function isRestoreMethod(mode: FormMode): mode is RestoreMethod {
  return mode === 'phrase' || mode === 'shares' || mode === 'key'
}

function isMismatchError(message: string | null | undefined): boolean {
  if (!message) return false
  return (
    message.includes('does not match the funded') ||
    message.includes('missing unlock keys') ||
    message.includes('Restore with your recovery') ||
    message.includes('Restore with a recovery')
  )
}

function normalizeRootKeyHex(raw: string): string {
  const s = raw.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error('Emergency key must be 64 hex characters')
  }
  return s.toLowerCase()
}

async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsText(file)
  })
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
    recoveryOnly ? 'phrase' : mode === 'locked' ? 'unlock' : 'create',
  )
  const [mnemonicInput, setMnemonicInput] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [share1, setShare1] = useState('')
  const [share2, setShare2] = useState('')
  const [rootKeyInput, setRootKeyInput] = useState('')
  const [offerRestoreOnLock, setOfferRestoreOnLock] = useState(false)
  const [unlockNudge, setUnlockNudge] = useState(false)
  const [pendingCreated, setPendingCreated] = useState<{
    profile: WalletProfile
    balanceSats: number
  } | null>(null)
  const shareFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (recoveryOnly) setFormMode('phrase')
  }, [recoveryOnly])

  useEffect(() => subscribeUnlockNudge(setUnlockNudge), [])

  useEffect(() => {
    if (mode === 'locked' && isMismatchError(error)) setOfferRestoreOnLock(true)
  }, [mode, error])

  const showRestoreMethods =
    isRestoreMethod(formMode) ||
    (mode === 'locked' && offerRestoreOnLock) ||
    recoveryOnly

  const finishCreated = async (unlocked: UnlockedVault) => {
    const active = await bootWallet({
      rootKeyHex: unlocked.rootKeyHex,
      handle: unlocked.record.handle,
      chain: unlocked.record.chain,
    })
    let balanceSats = await syncLegacyFunds({
      forceReview: true,
      announceReceive: false,
    })
    if (balanceSats == null) balanceSats = await fetchBalanceSats(active.wallet)
    send({ type: 'SUCCESS' })
    playWalletSound('unlock')
    clearUnlockNudge()
    const profile: WalletProfile = {
      handle: unlocked.record.handle,
      identityKey: unlocked.record.identityKey,
      address: unlocked.record.address,
      chain: unlocked.record.chain,
    }
    // First-time create/restore: pick backup configuration before entering the app.
    if (!getWalletConfigPrefs().mode) {
      setPendingCreated({ profile, balanceSats })
      return
    }
    onCreated(profile, balanceSats)
  }

  const submit = async () => {
    if (snapshot.matches('submitting')) return
    if (formMode === 'create' || isRestoreMethod(formMode)) {
      const pwError = validatePassword(snapshot.context.password)
      if (pwError) {
        onFail(pwError)
        return
      }
    } else if (snapshot.context.password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      // Unlock: accept existing shorter passwords created before the policy bump.
      onFail(`Password must be at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters`)
      return
    }
    const password = snapshot.context.password
    send({ type: 'SUBMIT' })
    try {
      if (formMode === 'phrase') {
        const unlocked = await restoreVaultFromMnemonic({
          mnemonic: mnemonicInput,
          password,
          chain,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        })
        await finishCreated(unlocked)
        return
      }

      if (formMode === 'shares') {
        const recovered = recoverRootKeyFromBrc140Shares([share1, share2])
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: recovered.rootKeyHex,
          password,
          chain,
        })
        await finishCreated(unlocked)
        return
      }

      if (formMode === 'key') {
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: normalizeRootKeyHex(rootKeyInput),
          password,
          chain,
        })
        await finishCreated(unlocked)
        return
      }

      if (formMode === 'create') {
        const unlocked = await createVault({ password, chain })
        await finishCreated(unlocked)
        return
      }

      const unlocked = await unlockVault(password)
      const active = await bootWallet({
        rootKeyHex: unlocked.rootKeyHex,
        handle: unlocked.record.handle,
        chain: unlocked.record.chain,
      })
      // Chain heal on unlock (parity): drop outs spent on other devices.
      let balanceSats = await syncLegacyFunds({
        forceReview: true,
        announceReceive: false,
      })
      if (balanceSats == null) balanceSats = await fetchBalanceSats(active.wallet)
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
        setFormMode('phrase')
      }
      send({ type: 'FAIL', error: message })
      playWalletSound('error')
      onFail(message)
    }
  }

  const onShareFile = async (file: File | null) => {
    if (!file) return
    try {
      const text = (await readTextFile(file)).trim()
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('.'))
      if (lines.length >= 2) {
        setShare1(lines[0]!)
        setShare2(lines[1]!)
      } else if (lines.length === 1) {
        if (!share1.trim()) setShare1(lines[0]!)
        else setShare2(lines[0]!)
      } else {
        onFail('No BRC-140 share lines found in that file')
      }
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    } finally {
      if (shareFileRef.current) shareFileRef.current.value = ''
    }
  }

  const title = isRestoreMethod(formMode)
    ? 'Restore on this device'
    : formMode === 'create'
      ? 'Create wallet'
      : 'Welcome back'

  const lede =
    formMode === 'phrase'
      ? 'Enter your BRC-75 recovery phrase and choose a password for this device. Same phrase = same identity on Desktop or Mobile.'
      : formMode === 'shares'
        ? 'Paste any two BRC-140 key slices and choose a password for this device. Same slices = same identity.'
        : formMode === 'key'
          ? 'Paste your emergency root key (64 hex chars) and choose a password for this device.'
          : formMode === 'create'
            ? 'Pick a password. Your keys stay on this device. To use another device later, back up with a phrase or BRC-140 slices after unlock.'
            : 'Enter your password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel = isRestoreMethod(formMode)
    ? 'Restore'
    : formMode === 'create'
      ? 'Create'
      : 'Unlock'

  if (pendingCreated) {
    return (
      <section className="auth-screen" data-aeon-scope="auth" data-aeon-state="setup-config">
        <WalletSetupConfigPanel
          onDone={() => {
            const pending = pendingCreated
            setPendingCreated(null)
            onCreated(pending.profile, pending.balanceSats)
          }}
        />
      </section>
    )
  }

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
        {recoveryOnly ? (
          <p className="auth-unlock-nudge" role="status">
            Unlock keys are missing. Restore with a recovery phrase, BRC-140 shares, or emergency
            key — creating a new wallet is blocked.
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
              aria-selected={isRestoreMethod(formMode)}
              className="auth-mode-tab"
              data-aeon-state={isRestoreMethod(formMode) ? 'selected' : 'idle'}
              onClick={() => setFormMode('phrase')}
            >
              Restore
            </button>
          </div>
        ) : null}

        {showRestoreMethods && isRestoreMethod(formMode) ? (
          <div className="auth-mode-switch" role="tablist" aria-label="Restore method">
            {RESTORE_METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={formMode === m.id}
                className="auth-mode-tab"
                data-aeon-state={formMode === m.id ? 'selected' : 'idle'}
                onClick={() => setFormMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : null}

        {formMode === 'phrase' ? (
          <>
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
            {showPassphrase ? (
              <div className="field" data-aeon-part="field">
                <label htmlFor="bip39-passphrase">BIP39 passphrase (optional)</label>
                <input
                  id="bip39-passphrase"
                  type="password"
                  placeholder="Only if you set one when creating the phrase"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <p className="auth-alt">
                <button
                  type="button"
                  className="auth-alt-link"
                  onClick={() => setShowPassphrase(true)}
                >
                  Phrase has a BIP39 passphrase?
                </button>
              </p>
            )}
          </>
        ) : null}

        {formMode === 'shares' ? (
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
            <p className="auth-alt">
              <button
                type="button"
                className="auth-alt-link"
                onClick={() => shareFileRef.current?.click()}
              >
                Import share file
              </button>
              <input
                ref={shareFileRef}
                type="file"
                accept=".txt,text/plain"
                hidden
                onChange={(e) => void onShareFile(e.target.files?.[0] ?? null)}
              />
            </p>
          </>
        ) : null}

        {formMode === 'key' ? (
          <div className="field" data-aeon-part="field">
            <label htmlFor="root-key">Emergency root key</label>
            <textarea
              id="root-key"
              rows={2}
              placeholder="64 hex characters"
              value={rootKeyInput}
              onChange={(e) => setRootKeyInput(e.target.value)}
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
            placeholder={
              formMode === 'unlock'
                ? 'Your password'
                : '10+ chars, letter and number'
            }
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
            Already have a backup?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('phrase')}>
              Restore
            </button>
          </p>
        ) : null}

        {mode === 'onboarding' && !recoveryOnly && isRestoreMethod(formMode) ? (
          <p className="auth-alt">
            New here?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('create')}>
              Create a wallet
            </button>
          </p>
        ) : null}

        {isRestoreMethod(formMode) ? (
          <p className="auth-lede auth-restore-note">
            History backups restore after unlock in Settings → History.
          </p>
        ) : null}
      </form>
    </section>
  )
}
