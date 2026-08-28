import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { useEffect, useRef, useState } from 'react'
import { unlockMachine } from '../machines/unlockMachine'
import {
  createVault,
  readVaultUnlockFactors,
  restoreVaultFromMnemonic,
  restoreVaultFromRootKey,
  unlockVault,
  unlockVaultWithDevice,
  type Chain,
  type UnlockedVault,
} from '../wallet/vault'
import { deviceAuthStatus, type DeviceAuthStatus } from '../wallet/deviceAuth'
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
import {
  generateWrapSecret,
  getDeviceLockMode,
  getOpenUnlockSecret,
  setDeviceLockMode,
  setOpenUnlockSecret,
  shouldAutoUnlock,
} from '../wallet/deviceLockPrefs'
import { PasswordField } from './PasswordField'
import { FingerprintIcon } from './icons'
import { CreateKeysBackupPanel } from './CreateKeysBackupPanel'
import { OnboardProtectPanel } from './OnboardProtectPanel'
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
  const [deviceStatus, setDeviceStatus] = useState<DeviceAuthStatus | null>(null)
  const [deviceUnlockAttempted, setDeviceUnlockAttempted] = useState(false)
  const [pendingOnboard, setPendingOnboard] = useState<{
    profile: WalletProfile
    balanceSats: number
    wrapPassword: string
    mnemonic: string | null
    rootKeyHex: string
    step: 'keys-backup' | 'history' | 'protect'
    kind: 'create' | 'restore'
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
    let cancelled = false
    void deviceAuthStatus().then((status) => {
      if (cancelled) return
      setDeviceStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'locked' || formMode !== 'unlock' || preparing) return
    if (!shouldAutoUnlock()) return
    const secret = getOpenUnlockSecret()
    if (!secret) return
    let cancelled = false
    setDeviceUnlockAttempted(true)
    send({ type: 'SUBMIT' })
    setPreparing({ title: 'Opening', lede: 'Opening your wallet on this device.' })
    void unlockVault(secret)
      .then((unlocked) => {
        if (cancelled) return
        return finishUnlock(unlocked, secret)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setPreparing(null)
        send({ type: 'FAIL', error: message })
        onFail(message)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, formMode])

  useEffect(() => {
    if (mode !== 'locked' || formMode !== 'unlock' || deviceUnlockAttempted || preparing) return
    if (shouldAutoUnlock()) return
    const factors = readVaultUnlockFactors()
    if (!factors.device) return

    // Never Touch-ID prompt while the window is hidden (close / alt-tab). Wait
    // until the user is looking at the lock screen again.
    let cancelled = false
    const run = () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return
      }
      setDeviceUnlockAttempted(true)
      ;(async () => {
        send({ type: 'SUBMIT' })
        setPreparing({
          title: 'Unlocking',
          lede: 'Confirm with this device…',
        })
        try {
          const unlocked = await unlockVaultWithDevice('Unlock HandCash')
          if (cancelled) return
          await finishUnlock(unlocked, null)
        } catch (err) {
          if (cancelled) return
          const message = err instanceof Error ? err.message : String(err)
          setPreparing(null)
          send({ type: 'FAIL', error: message === 'cancelled' ? '' : message })
          if (message !== 'cancelled') {
            playWalletSound('error')
            if (!readVaultUnlockFactors().password) onFail(message)
          }
        }
      })()
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      const onVis = () => {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVis)
          run()
        }
      }
      document.addEventListener('visibilitychange', onVis)
      return () => {
        cancelled = true
        document.removeEventListener('visibilitychange', onVis)
      }
    }

    run()
    return () => {
      cancelled = true
    }
    // Intentionally once per lock screen mount when device factor exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, formMode])

  useEffect(() => {
    if (mode === 'locked' && isWalletMismatchMessage(error)) setOfferRestoreOnLock(true)
  }, [mode, error])

  const showRestoreMethods =
    isRestoreMethod(formMode) ||
    (mode === 'locked' && offerRestoreOnLock) ||
    recoveryOnly

  const finishCreated = async (
    unlocked: UnlockedVault,
    password: string | null,
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
      mnemonic: unlocked.mnemonic,
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
    // Linear onboarding: backup (create) or history (restore), then protect.
    if (kind === 'create') {
      setPendingOnboard({
        profile,
        balanceSats,
        wrapPassword: password ?? '',
        mnemonic: unlocked.mnemonic,
        rootKeyHex: unlocked.rootKeyHex,
        step: unlocked.mnemonic ? 'keys-backup' : 'protect',
        kind,
      })
      setPreparing(null)
      if (password) setSessionBackupPassword(password)
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
      if (password) setSessionBackupPassword(password)
      setPendingOnboard({
        profile,
        balanceSats,
        wrapPassword: password ?? '',
        mnemonic: unlocked.mnemonic,
        rootKeyHex: unlocked.rootKeyHex,
        step: 'history',
        kind,
      })
      setPreparing(null)
      return
    }
    setPreparing(null)
    onCreated(profile, balanceSats)
    if (password) setSessionBackupPassword(password)
    void recomposeWallet({ password: password ?? undefined, reason: kind })
  }

  const finishUnlock = async (unlocked: UnlockedVault, password: string | null) => {
    setPreparing({
      title: 'Almost ready',
      lede: 'Opening your wallet on this device.',
    })
    const active = await bootWallet({
      rootKeyHex: unlocked.rootKeyHex,
      handle: unlocked.record.handle,
      chain: unlocked.record.chain,
      mnemonic: unlocked.mnemonic,
    })
    const cachedBalance = lastKnownBalance()
    const confirmedBalance = fetchBalanceRead(active.wallet, {
      creditUnconfirmed: false,
    })
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
      setPreparing({
        title: 'Almost ready',
        lede: 'Recovering wallet history…',
      })
      if (password) setSessionBackupPassword(password)
      const restored = await recomposeWallet({
        password: password ?? undefined,
        reason: 'unlock',
      })
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
    void fetchBalanceSats(active.wallet)
      .then((fresh) => {
        if (fresh !== balanceSats) onBalanceRefreshed(fresh)
      })
      .catch(() => {
        /* trusted/confirmed figure remains visible */
      })
    if (password) setSessionBackupPassword(password)
    if (!recomposedBeforeEnter) {
      void recomposeWallet({ password: password ?? undefined, reason: 'unlock' }).then((result) => {
        if (
          result.spendableSats != null &&
          !(result.spendableSats === 0 && result.history === 'failed')
        ) {
          onBalanceRefreshed(result.spendableSats)
        }
      })
    }
  }

  const needsNewPassword = false

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
    } else if (formMode === 'unlock') {
      const factors = readVaultUnlockFactors()
      if (!factors.password) {
        onFail('Unlock with this device, or restore from a backup.')
        return
      }
      if (snapshot.context.password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
        onFail(`Password must be at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters`)
        return
      }
    }
    const wrapPassword =
      formMode === 'create' || isRestoreMethod(formMode) ? generateWrapSecret() : null
    const password =
      formMode === 'unlock' ? snapshot.context.password : wrapPassword
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
      if (wrapPassword) {
        setOpenUnlockSecret(wrapPassword)
        setDeviceLockMode('none')
      }
      const factorArgs = {
        ...(password ? { password } : {}),
      }

      if (formMode === 'phrase') {
        const unlocked = await restoreVaultFromMnemonic({
          mnemonic: mnemonicInput,
          chain,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
          ...factorArgs,
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'shares') {
        const recovered = recoverRootKeyFromBrc140Shares([share1, share2])
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: recovered.rootKeyHex,
          chain,
          ...factorArgs,
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'key') {
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: normalizeRootKeyHex(rootKeyInput),
          chain,
          ...factorArgs,
        })
        await finishCreated(unlocked, password, 'restore')
        return
      }

      if (formMode === 'create') {
        const unlocked = await createVault({ chain, ...factorArgs })
        await finishCreated(unlocked, password, 'create')
        return
      }

      const unlocked = await unlockVault(password!)
      await finishUnlock(unlocked, password)
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
      ? 'Enter your BRC-75 recovery phrase. Same phrase = same identity on Desktop or Mobile.'
      : formMode === 'shares'
          ? 'Paste any two BRC-140 key slices. Same slices = same identity.'
          : formMode === 'key'
            ? 'Paste your emergency root key (64 hex chars).'
            : formMode === 'create'
              ? 'Your keys stay on this device. Next you’ll back up a recovery phrase and choose how this device unlocks.'
              : shouldAutoUnlock()
                ? 'Opening your wallet on this device.'
                : readVaultUnlockFactors().device
                  ? 'Unlock with this device, or your HandCash password.'
                  : 'Enter your HandCash password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel = isRestoreMethod(formMode)
    ? 'Restore'
    : formMode === 'create'
      ? 'Create'
      : 'Unlock'

  const enterFromOnboard = (
    pending: NonNullable<typeof pendingOnboard>,
    sessionPassword: string | null,
    balanceSats?: number,
  ) => {
    try {
      applyDefaultRestoreWalletSetup()
    } catch (err) {
      console.warn('[auth] setup defaults failed', err)
    }
    if (sessionPassword) setSessionBackupPassword(sessionPassword)
    const sats = balanceSats ?? pending.balanceSats
    setPendingOnboard(null)
    onCreated(pending.profile, sats)
    void recomposeWallet({
      password: sessionPassword || undefined,
      reason: pending.kind,
    })
  }

  if (pendingOnboard?.step === 'history') {
    return (
      <section
        className="auth-screen"
        data-aeon-scope="auth"
        data-aeon-state="history-recovery"
      >
        <HistoryRecoveryPanel
          onDone={(balanceSats) => {
            const pending = pendingOnboard
            if (!pending) return
            writeTrustedBalance(
              pending.profile.identityKey,
              pending.profile.chain,
              balanceSats,
            )
            setPendingOnboard({
              ...pending,
              balanceSats,
              step: 'protect',
            })
          }}
          onSkip={() => {
            const pending = pendingOnboard
            if (!pending) return
            setPendingOnboard({ ...pending, step: 'protect' })
          }}
        />
      </section>
    )
  }

  if (pendingOnboard?.step === 'keys-backup' && pendingOnboard.mnemonic) {
    return (
      <section className="auth-screen" data-aeon-scope="auth" data-aeon-state="keys-backup">
        <CreateKeysBackupPanel
          mnemonic={pendingOnboard.mnemonic}
          rootKeyHex={pendingOnboard.rootKeyHex}
          onDone={() => {
            setPendingOnboard({ ...pendingOnboard, step: 'protect' })
          }}
        />
      </section>
    )
  }

  if (pendingOnboard?.step === 'protect') {
    return (
      <section className="auth-screen" data-aeon-scope="auth" data-aeon-state="protect">
        <OnboardProtectPanel
          wrapPassword={pendingOnboard.wrapPassword}
          onDone={(sessionPassword) => {
            enterFromOnboard(pendingOnboard, sessionPassword)
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

        {(formMode === 'unlock' &&
          readVaultUnlockFactors().password &&
          getDeviceLockMode() !== 'none') ||
        needsNewPassword ? (
          <>
            <PasswordField
              id="password"
              label="HandCash password"
              placeholder={
                formMode === 'unlock' ? 'Your password' : '10+ chars, letter and number'
              }
              value={snapshot.context.password}
              onChange={(e) => send({ type: 'CHANGE', password: e.target.value })}
              autoComplete={formMode === 'unlock' ? 'current-password' : 'new-password'}
              autoFocus={formMode === 'unlock' || (needsNewPassword && formMode === 'create')}
            />

            {needsNewPassword ? (
              <>
                <p className="password-hint">
                  Optional backup unlock, separate from fingerprint or your phone/computer password.
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
          </>
        ) : null}

        {formMode === 'unlock' && readVaultUnlockFactors().device ? (
          <div className="auth-touchid">
            <button
              type="button"
              className="auth-touchid-btn"
              disabled={submitting || Boolean(preparing)}
              aria-label={`Unlock with ${deviceStatus?.label ?? 'Touch ID'}`}
              title={deviceStatus?.label ?? 'Touch ID'}
              onClick={() => {
                setDeviceUnlockAttempted(true)
                send({ type: 'SUBMIT' })
                setPreparing({ title: 'Unlocking', lede: 'Confirm with this device…' })
                void unlockVaultWithDevice('Unlock HandCash')
                  .then((unlocked) => finishUnlock(unlocked, null))
                  .catch((err) => {
                    const message = err instanceof Error ? err.message : String(err)
                    setPreparing(null)
                    send({ type: 'FAIL', error: message === 'cancelled' ? '' : message })
                    if (message !== 'cancelled') {
                      playWalletSound('error')
                      onFail(message)
                    }
                  })
              }}
            >
              <FingerprintIcon size={26} />
            </button>
          </div>
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
            Next you’ll restore history, then choose how this device unlocks.
          </p>
        ) : null}
      </form>

    </section>
  )
}
