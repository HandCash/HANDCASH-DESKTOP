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
import { UNLOCK_PASSWORD_MIN_LENGTH, validatePassword } from '../wallet/passwordPolicy'
import { recoverRootKeyFromBrc140Shares } from '../wallet/brc140Backup'
import {
  retrieveBackupShare,
  startBackupServiceAuth,
  userIdHashFromEmail,
  verifyBackupServiceAuth,
} from '../wallet/backupServiceClient'
import {
  decodePairingQr,
  resolvePairingPackage,
  type PairingPackage,
} from '../wallet/deviceLinkProtocol'
import { setHistoryBackupPrefs } from '../wallet/historyBackupPrefs'
import { playWalletSound } from '../wallet/soundService'
import { QrScanner } from './QrScanner'
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

/** Custody restore paths the vault can bootstrap from. */
type RestoreMethod = 'phrase' | 'shares' | 'key' | 'services'
type FormMode = 'create' | 'unlock' | 'connect' | RestoreMethod

const RESTORE_METHODS: { id: RestoreMethod; label: string }[] = [
  { id: 'phrase', label: 'Phrase' },
  { id: 'shares', label: 'Shares' },
  { id: 'key', label: 'Key' },
  { id: 'services', label: 'Services' },
]

function isRestoreMethod(mode: FormMode): mode is RestoreMethod {
  return (
    mode === 'phrase' || mode === 'shares' || mode === 'key' || mode === 'services'
  )
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
  const [serviceEmail, setServiceEmail] = useState('')
  const [serviceUrl1, setServiceUrl1] = useState('http://127.0.0.1:8787')
  const [serviceUrl2, setServiceUrl2] = useState('http://127.0.0.1:8788')
  const [connectPkg, setConnectPkg] = useState<PairingPackage | null>(null)
  const [connectPaste, setConnectPaste] = useState('')
  const [offerRestoreOnLock, setOfferRestoreOnLock] = useState(false)
  const [unlockNudge, setUnlockNudge] = useState(false)
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
  }

  const submit = async () => {
    if (snapshot.matches('submitting')) return
    if (formMode === 'create' || isRestoreMethod(formMode) || formMode === 'connect') {
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

      if (formMode === 'services') {
        const email = serviceEmail.trim().toLowerCase()
        if (!email.includes('@')) throw new Error('Enter the email used with backup services')
        const urls = [serviceUrl1, serviceUrl2].map((u) => u.trim().replace(/\/+$/, ''))
        if (urls.some((u) => !u)) throw new Error('Enter two backup service URLs')
        const userIdHash = await userIdHashFromEmail(email)
        const shares: string[] = []
        for (const url of urls) {
          const started = await startBackupServiceAuth(url, email)
          const code = started.devCode
          if (!code) {
            throw new Error(
              'This restore path currently needs a local/dev backup service that returns OTP in the response.',
            )
          }
          const { token } = await verifyBackupServiceAuth(url, started.requestId, code)
          shares.push(await retrieveBackupShare(url, token, userIdHash))
        }
        const recovered = recoverRootKeyFromBrc140Shares(shares)
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: recovered.rootKeyHex,
          password,
          chain,
        })
        await finishCreated(unlocked)
        return
      }

      if (formMode === 'connect') {
        if (!connectPkg) throw new Error('Scan or paste a link QR from the other device first')
        const unlocked = await restoreVaultFromRootKey({
          rootKeyHex: connectPkg.rootKeyHex,
          password,
          chain: connectPkg.chain,
          handle: connectPkg.handle || undefined,
        })
        if (connectPkg.historyBackupBaseUrl) {
          setHistoryBackupPrefs({ baseUrl: connectPkg.historyBackupBaseUrl })
        }
        await finishCreated(unlocked)
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

  const ingestConnectQr = async (text: string) => {
    try {
      const offer = decodePairingQr(text)
      const pkg = await resolvePairingPackage(offer)
      setConnectPkg(pkg)
      playWalletSound('soft')
    } catch (err) {
      playWalletSound('error')
      onFail(err instanceof Error ? err.message : String(err))
    }
  }

  const title =
    formMode === 'connect'
      ? 'Connect existing wallet'
      : isRestoreMethod(formMode)
        ? 'Restore wallet'
        : formMode === 'create'
          ? 'Create wallet'
          : 'Welcome back'

  const lede =
    formMode === 'connect'
      ? 'Scan the link QR from your other HandCash device (phone or Desktop), then choose a password for this computer.'
      : formMode === 'phrase'
        ? 'Enter your recovery phrase and choose a password for this device.'
        : formMode === 'shares'
          ? 'Paste any two BRC-140 key slices and choose a password for this device.'
          : formMode === 'key'
            ? 'Paste your emergency root key (64 hex chars) and choose a password for this device.'
            : formMode === 'create'
              ? 'Pick a password. Your keys stay on this device. Back up with a phrase, key slices, or emergency key after unlock.'
              : 'Enter your password to unlock.'

  const submitting = snapshot.matches('submitting')
  const primaryLabel =
    formMode === 'connect'
      ? 'Connect'
      : isRestoreMethod(formMode)
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

        {formMode === 'services' ? (
          <>
            <div className="field" data-aeon-part="field">
              <label htmlFor="service-email">Email</label>
              <input
                id="service-email"
                type="email"
                placeholder="you@example.com"
                value={serviceEmail}
                onChange={(e) => setServiceEmail(e.target.value)}
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="field" data-aeon-part="field">
              <label htmlFor="service-url-1">Backup service 1</label>
              <input
                id="service-url-1"
                type="url"
                placeholder="http://127.0.0.1:8787"
                value={serviceUrl1}
                onChange={(e) => setServiceUrl1(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="field" data-aeon-part="field">
              <label htmlFor="service-url-2">Backup service 2</label>
              <input
                id="service-url-2"
                type="url"
                placeholder="http://127.0.0.1:8788"
                value={serviceUrl2}
                onChange={(e) => setServiceUrl2(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="auth-alt">
              Authenticate with any two enrolled backup services to rebuild the wallet.
            </p>
          </>
        ) : null}

        {formMode === 'connect' ? (
          <>
            {!connectPkg ? (
              <>
                <QrScanner
                  active={!submitting}
                  onScan={(text) => void ingestConnectQr(text)}
                />
                <div className="field" data-aeon-part="field">
                  <label htmlFor="connect-paste">Or paste link payload</label>
                  <input
                    id="connect-paste"
                    value={connectPaste}
                    onChange={(e) => setConnectPaste(e.target.value)}
                    placeholder="handcash-link:…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!connectPaste.trim()}
                  onClick={() => void ingestConnectQr(connectPaste)}
                >
                  Use pasted link
                </button>
              </>
            ) : (
              <p className="auth-alt">
                Received <strong>{connectPkg.handle || connectPkg.identityKey.slice(0, 12)}</strong>.
                Choose a password for this{' '}
                {document.documentElement.classList.contains('platform-mobile')
                  ? 'phone'
                  : 'Desktop'}
                .
              </p>
            )}
          </>
        ) : null}

        {formMode !== 'connect' || connectPkg ? (
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
        ) : null}

        {(error || snapshot.context.error) && (
          <p className="error auth-error" role="alert">
            {error || snapshot.context.error}
          </p>
        )}

        {formMode !== 'connect' || connectPkg ? (
          <button
            type="submit"
            className="btn btn-primary auth-submit"
            data-aeon-part="trigger"
            data-aeon-state={stateAttr}
            disabled={submitting}
          >
            {submitting ? 'Working…' : primaryLabel}
          </button>
        ) : null}

        {mode === 'onboarding' && !recoveryOnly && formMode === 'create' ? (
          <p className="auth-alt">
            Already have a wallet?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('connect')}>
              Connect existing
            </button>
            {' · '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('phrase')}>
              Restore backup
            </button>
          </p>
        ) : null}

        {mode === 'onboarding' && !recoveryOnly && formMode === 'connect' ? (
          <p className="auth-alt">
            <button
              type="button"
              className="auth-alt-link"
              onClick={() => {
                setConnectPkg(null)
                setFormMode('create')
              }}
            >
              Create a wallet
            </button>
            {' · '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('phrase')}>
              Restore backup
            </button>
          </p>
        ) : null}

        {mode === 'onboarding' && !recoveryOnly && isRestoreMethod(formMode) ? (
          <p className="auth-alt">
            New here?{' '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('create')}>
              Create a wallet
            </button>
            {' · '}
            <button type="button" className="auth-alt-link" onClick={() => setFormMode('connect')}>
              Connect existing
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
