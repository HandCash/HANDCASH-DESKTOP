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
import {
  bootWallet,
  fetchBalanceRead,
  fetchBalanceSats,
  lastKnownBalance,
} from '../wallet/session'
import { UNLOCK_PASSWORD_MIN_LENGTH, validatePassword } from '../wallet/passwordPolicy'
import { recoverRootKeyFromBrc140Shares } from '../wallet/brc140Backup'
import { playWalletSound } from '../wallet/soundService'
import { appendAppLog } from '../wallet/appLog'
import {
  classifyUnlockFailure,
  isWalletMismatchMessage,
  rawUnlockError,
} from '../wallet/unlockFailure'
import {
  clearUnlockNudge,
  subscribeUnlockNudge,
} from '../wallet/walletHealth'
import type { WalletProfile } from '../machines/appMachine'
import { getWalletConfigPrefs } from '../wallet/walletConfig'
import {
  applyDefaultRestoreWalletSetup,
  ensureHandCashServiceDefaults,
} from '../wallet/walletSetupApply'
import { recomposeWallet } from '../wallet/recompose'
import { setSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { writeTrustedBalance } from '../wallet/balanceSnapshot'
import { PasswordField } from './PasswordField'
import { WalletSetupConfigPanel } from './WalletSetupConfigPanel'
import { HistoryRecoveryPanel } from './HistoryRecoveryPanel'

type Props = {
  mode: 'onboarding' | 'locked'
  error: string | null
  /** Toolbox has funds but no vault — create is hidden. */
  recoveryOnly?: boolean
  onCreated: (profile: WalletProfile, balanceSats: number) => void
  onUnlocked: (profile: WalletProfile, balanceSats: number) => void
  onBalanceRefreshed: (balanceSats: number) => void
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
  onBalanceRefreshed,
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
  const [confirmPassword, setConfirmPassword] = useState('')
  const [offerRestoreOnLock, setOfferRestoreOnLock] = useState(false)
  const [unlockNudge, setUnlockNudge] = useState(false)
  const [pendingCreated, setPendingCreated] = useState<{
    profile: WalletProfile
    balanceSats: number
    password: string
  } | null>(null)
  /** After key restore — pull BRC-39 before entering the wallet. */
  const [pendingHistoryRecovery, setPendingHistoryRecovery] = useState<{
    profile: WalletProfile
    balanceSats: number
    password: string
  } | null>(null)
  /** Holds the create/unlock form off-screen while vault boots — avoids password flash. */
  const [preparing, setPreparing] = useState<{ title: string; lede: string } | null>(null)
  const shareFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (recoveryOnly) setFormMode('phrase')
  }, [recoveryOnly])

  useEffect(() => {
    setConfirmPassword('')
  }, [formMode])

  useEffect(() => subscribeUnlockNudge(setUnlockNudge), [])

  useEffect(() => {
    if (mode === 'locked' && isWalletMismatchMessage(error)) setOfferRestoreOnLock(true)
  }, [mode, error])

  const showRestoreMethods =
    isRestoreMethod(formMode) ||
    (mode === 'locked' && offerRestoreOnLock) ||
    recoveryOnly

  const finishCreated = async (
    unlocked: UnlockedVault,
    password: string,
    kind: 'create' | 'restore',
  ) => {
    setPreparing({
      title: 'Almost ready',
      lede: 'Opening your wallet on this device.',
    })
    const active = await bootWallet({
      rootKeyHex: unlocked.rootKeyHex,
      handle: unlocked.record.handle,
      chain: unlocked.record.chain,
    })
    // Never block create/restore on chain/cloud or the expensive unconfirmed-
    // change scan. A confirmed localState read gets a short head start;
    // Dashboard/recompose heals the full displayed balance in the background.
    let balanceSats = 0
    try {
      balanceSats = await Promise.race([
        fetchBalanceSats(active.wallet, { creditUnconfirmed: false }),
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
      ])
    } catch {
      balanceSats = 0
    }
    send({ type: 'SUCCESS' })
    playWalletSound('unlock')
    clearUnlockNudge()
    const profile: WalletProfile = {
      handle: unlocked.record.handle,
      identityKey: unlocked.record.identityKey,
      address: unlocked.record.address,
      chain: unlocked.record.chain,
    }
    // Create only: ask for backup preferences. Restore already recovered keys —
    // next step is history recovery (balance / activity / friends / apps).
    if (kind === 'create' && !getWalletConfigPrefs().mode) {
      setPendingCreated({ profile, balanceSats, password })
      setPreparing(null)
      setSessionBackupPassword(password)
      return
    }
    if (kind === 'restore') {
      if (!getWalletConfigPrefs().mode) {
        try {
          applyDefaultRestoreWalletSetup()
        } catch (err) {
          console.warn('[auth] restore setup defaults failed', err)
        }
      }
      setSessionBackupPassword(password)
      setPendingHistoryRecovery({ profile, balanceSats, password })
      setPreparing(null)
      return
    }
    setPreparing(null)
    onCreated(profile, balanceSats)
    setSessionBackupPassword(password)
    void recomposeWallet({ password, reason: kind })
  }

  const needsNewPassword = formMode === 'create' || isRestoreMethod(formMode)

  const submit = async () => {
    if (snapshot.matches('submitting') || preparing) return
    if (needsNewPassword) {
      const pwError = validatePassword(snapshot.context.password)
      if (pwError) {
        onFail(pwError)
        return
      }
      if (snapshot.context.password !== confirmPassword) {
        onFail('Passwords do not match')
        return
      }
    } else if (snapshot.context.password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      // Unlock: accept existing shorter passwords created before the policy bump.
      onFail(`Password must be at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters`)
      return
    }
    const password = snapshot.context.password
    send({ type: 'SUBMIT' })
    setPreparing(
      formMode === 'create'
        ? {
            title: 'Creating wallet',
            lede: 'Generating keys and sealing them on this device.',
          }
        : isRestoreMethod(formMode)
          ? {
              title: 'Restoring wallet',
              lede: 'Verifying your backup and sealing keys on this device.',
            }
          : {
              title: 'Unlocking',
              lede: 'Opening your wallet on this device.',
            },
    )
    try {
      if (formMode === 'phrase') {
        const unlocked = await restoreVaultFromMnemonic({
          mnemonic: mnemonicInput,
          password,
          chain,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'shares') {
        const recovered = recoverRootKeyFromBrc140Shares([share1, share2])
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: recovered.rootKeyHex,
          password,
          chain,
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'key') {
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: normalizeRootKeyHex(rootKeyInput),
          password,
          chain,
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'create') {
        const unlocked = await createVault({ password, chain })
        await finishCreated(unlocked, password, 'create')
        return
      }

      const unlocked = await unlockVault(password)
      setPreparing({
        title: 'Almost ready',
        lede: 'Opening your wallet on this device.',
      })
      const active = await bootWallet({
        rootKeyHex: unlocked.rootKeyHex,
        handle: unlocked.record.handle,
        chain: unlocked.record.chain,
      })
      // Enter with the last balance actually read for this identity. On a cold
      // phone the fresh owned-cash scan can take >10s; racing it against a
      // literal zero made a funded wallet look empty for the whole sync.
      const cachedBalance = lastKnownBalance()
      const confirmedBalance = fetchBalanceRead(active.wallet, {
        creditUnconfirmed: false,
      })
      // If this identity has never written a trusted snapshot, wait for a real
      // local-state answer. The old 500 ms race returned a literal zero and
      // briefly told a funded holder their wallet was empty. A cached identity
      // still opens immediately while the authoritative read continues.
      const initialRead = cachedBalance == null ? await confirmedBalance : null
      if (initialRead?.kind === 'unavailable') {
        throw new Error(
          'HandCash could not read this wallet’s balance yet. Your cached wallet data was not changed; try unlocking again.',
        )
      }
      let balanceSats =
        cachedBalance ?? (initialRead?.kind === 'ok' ? initialRead.sats : null)
      if (balanceSats == null) {
        throw new Error('HandCash could not establish this wallet’s balance.')
      }
      let recomposedBeforeEnter = false
      if (cachedBalance == null && balanceSats === 0) {
        // An empty local Toolbox on cold launch may only mean that BRC-39 has
        // not restored this device yet. With no identity-scoped snapshot there
        // is nothing honest to paint, so remain on "Almost ready" until the
        // recovery path confirms the final answer. Zero is shown only if that
        // path also says zero.
        setSessionBackupPassword(password)
        const restored = await recomposeWallet({ password, reason: 'unlock' })
        if (
          restored.spendableSats == null ||
          (restored.spendableSats === 0 && restored.history === 'failed')
        ) {
          throw new Error(
            'HandCash could not confirm an empty wallet during recovery. Your cached wallet data was not changed; check the connection and try again.',
          )
        }
        balanceSats = restored.spendableSats
        recomposedBeforeEnter = true
      }
      if (cachedBalance == null) {
        writeTrustedBalance(active.identityKey, active.chain, balanceSats)
      }
      send({ type: 'SUCCESS' })
      playWalletSound('unlock')
      clearUnlockNudge()
      setPreparing(null)
      try {
        ensureHandCashServiceDefaults()
      } catch {
        /* ignore */
      }
      onUnlocked(
        {
          handle: unlocked.record.handle,
          identityKey: unlocked.record.identityKey,
          address: unlocked.record.address,
          chain: unlocked.record.chain,
        },
        balanceSats,
      )
      if (!recomposedBeforeEnter) {
        void confirmedBalance.then((fresh) => {
          // This read began before recompose. Its zero is a view of the old
          // localState, not authority to erase a funded snapshot; the final
          // recompose result below owns that decision.
          if (
            fresh.kind === 'ok' &&
            fresh.sats === 0 &&
            cachedBalance != null &&
            cachedBalance > 0
          ) {
            return
          }
          if (fresh.kind === 'ok' && fresh.sats !== balanceSats) {
            onBalanceRefreshed(fresh.sats)
          }
        })
      }
      // Credit live local change only after the wallet is visible. This can
      // inspect hundreds of old output rows and must never hold the unlock UI.
      void fetchBalanceSats(active.wallet)
        .then((fresh) => {
          if (fresh !== balanceSats) onBalanceRefreshed(fresh)
        })
        .catch(() => {
          /* trusted/confirmed figure remains visible */
        })
      setSessionBackupPassword(password)
      if (!recomposedBeforeEnter) {
        void recomposeWallet({ password, reason: 'unlock' }).then((result) => {
          if (
            result.spendableSats != null &&
            !(result.spendableSats === 0 && result.history === 'failed')
          ) {
            onBalanceRefreshed(result.spendableSats)
          }
        })
      }
    } catch (err) {
      const failure = classifyUnlockFailure(err)
      setPreparing(null)
      if (failure.kind !== 'other') {
        // Chromium's own text is what support needs; the holder sees the translation.
        appendAppLog('warn', `Unlock failed (${failure.kind}): ${rawUnlockError(err)}`)
      }
      if (mode === 'locked' && failure.offerRestore) {
        setOfferRestoreOnLock(true)
        setFormMode('phrase')
      }
      send({ type: 'FAIL', error: failure.message })
      playWalletSound('error')
      onFail(failure.message)
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
      ? 'Enter your BRC-75 recovery phrase, then set a password for this device. Same phrase = same identity on Desktop or Mobile.'
      : formMode === 'shares'
          ? 'Paste any two BRC-140 key slices, then set a password for this device. Same slices = same identity.'
          : formMode === 'key'
            ? 'Paste your emergency root key (64 hex chars), then set a password for this device.'
            : formMode === 'create'
              ? 'Your keys stay on this device. Back up later with a recovery phrase or BRC-140 slices.'
              : 'Enter your password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel = isRestoreMethod(formMode)
    ? 'Restore'
    : formMode === 'create'
      ? 'Create'
      : 'Unlock'

  if (pendingHistoryRecovery) {
    return (
      <section
        className="auth-screen"
        data-aeon-scope="auth"
        data-aeon-state="history-recovery"
      >
        <HistoryRecoveryPanel
          onDone={() => {
            const pending = pendingHistoryRecovery
            if (!pending) return
            setPendingHistoryRecovery(null)
            setSessionBackupPassword(pending.password)
            onCreated(pending.profile, pending.balanceSats)
          }}
          onSkip={() => {
            const pending = pendingHistoryRecovery
            if (!pending) return
            setPendingHistoryRecovery(null)
            setSessionBackupPassword(pending.password)
            onCreated(pending.profile, pending.balanceSats)
            void recomposeWallet({ password: pending.password, reason: 'restore' })
          }}
        />
      </section>
    )
  }

  if (pendingCreated) {
    return (
      <section className="auth-screen" data-aeon-scope="auth" data-aeon-state="setup-config">
        <WalletSetupConfigPanel
          onDone={() => {
            const pending = pendingCreated
            if (!pending) return
            setPreparing({
              title: 'Finishing setup',
              lede: 'Applying your backup preferences.',
            })
            setPendingCreated(null)
            // Enter immediately — cloud push must never block the first unlock.
            setPreparing(null)
            onCreated(pending.profile, pending.balanceSats)
            setSessionBackupPassword(pending.password)
            void recomposeWallet({ password: pending.password, reason: 'create' })
          }}
        />
      </section>
    )
  }

  if (preparing) {
    return (
      <section
        className="auth-screen auth-preparing"
        data-aeon-scope="auth"
        data-aeon-state="preparing"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="auth-copy">
          <h1 className="auth-title">{preparing.title}</h1>
          <p className="auth-lede">{preparing.lede}</p>
        </div>
        <div className="auth-preparing-bar" aria-hidden>
          <span className="auth-preparing-bar-fill" />
        </div>
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
            Unlock keys are missing. Restore with a recovery phrase, BRC-140 shares, or an emergency
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

        <PasswordField
          id="password"
          label="Password"
          placeholder={
            formMode === 'unlock' ? 'Your password' : '10+ chars, letter and number'
          }
          value={snapshot.context.password}
          onChange={(e) => send({ type: 'CHANGE', password: e.target.value })}
          autoComplete={formMode === 'unlock' ? 'current-password' : 'new-password'}
          autoFocus={formMode === 'unlock' || formMode === 'create'}
        />

        {needsNewPassword ? (
          <>
            <p className="password-hint">
              This password unlocks the wallet on this device. Don’t forget it.
            </p>
            <PasswordField
              id="password-confirm"
              label="Confirm password"
              placeholder="Type it again"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </>
        ) : null}

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
            Next you’ll restore history (balance, activity, friends, apps) — sealed to
            this wallet’s key, not your unlock password.
          </p>
        ) : null}
      </form>

    </section>
  )
}
