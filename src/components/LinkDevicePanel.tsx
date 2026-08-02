import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import {
  PAIRING_QR_PREFIX,
  createEmbeddedPairingOffer,
  decodePairingQr,
  resolvePairingPackage,
  type PairingOfferV2,
} from '../wallet/deviceLinkProtocol'
import { getHistoryBackupPrefs, setHistoryBackupPrefs } from '../wallet/historyBackupPrefs'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  hasVault,
  revealRootKeyHex,
  readVaultMeta,
  restoreVaultFromRootKey,
} from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { QrScanner } from './QrScanner'
import { clearActiveWallet } from '../wallet/session'

const TTL_MS = 120_000

type Mode = 'show' | 'scan'

export function LinkDevicePanel() {
  const meta = readVaultMeta()
  const [mode, setMode] = useState<Mode>('show')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [offer, setOffer] = useState<PairingOfferV2 | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [manual, setManual] = useState('')
  const [scanPassword, setScanPassword] = useState('')
  const [pendingPkg, setPendingPkg] = useState<Awaited<
    ReturnType<typeof resolvePairingPackage>
  > | null>(null)

  useEffect(() => {
    if (!offer) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        setQrDataUrl(null)
        setOffer(null)
      }
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [offer])

  const startShow = async () => {
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Enter your wallet password')
      return
    }
    setBusy(true)
    try {
      const rootKeyHex = await revealRootKeyHex(password)
      const { offer: next, qrText } = await createEmbeddedPairingOffer(
        {
          v: 1,
          rootKeyHex,
          handle: meta?.handle ?? '',
          identityKey: meta?.identityKey ?? '',
          address: meta?.address ?? '',
          chain: meta?.chain ?? 'main',
          historyBackupBaseUrl: getHistoryBackupPrefs().baseUrl,
          createdAt: Date.now(),
        },
        TTL_MS,
      )
      // Dense embedded-link payloads need a large, low-ECC render to stay scannable.
      const dataUrl = await QRCode.toDataURL(qrText, {
        margin: 2,
        width: 512,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'L',
      })
      setOffer(next)
      setQrDataUrl(dataUrl)
      setPassword('')
      playWalletSound('soft')
      toastSuccess('Scan on the other device')
    } catch (err) {
      playWalletSound('error')
      toastError('Could not create link QR', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ingestQr = async (text: string) => {
    const raw = text.trim()
    // Keep the camera running for unrelated / partial reads.
    if (!raw.startsWith(PAIRING_QR_PREFIX)) return
    if (busy || pendingPkg) return
    setBusy(true)
    try {
      const decoded = decodePairingQr(raw)
      const pkg = await resolvePairingPackage(decoded)
      setPendingPkg(pkg)
      playWalletSound('soft')
      toastSuccess('Wallet received — set a password for this device')
    } catch (err) {
      playWalletSound('error')
      toastError('Invalid link', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const finishScanInstall = async () => {
    if (!pendingPkg) return
    if (scanPassword.length < 10 || !/[a-zA-Z]/.test(scanPassword) || !/[0-9]/.test(scanPassword)) {
      toastError('Password: 10+ chars, letter and number')
      return
    }
    if (hasVault()) {
      const existing = readVaultMeta()
      if (existing && existing.identityKey !== pendingPkg.identityKey) {
        toastError('Wipe this Desktop wallet first, or use Show QR to send it to the other device')
        return
      }
    }
    setBusy(true)
    try {
      clearActiveWallet()
      const unlocked = await restoreVaultFromRootKey({
        rootKeyHex: pendingPkg.rootKeyHex,
        password: scanPassword,
        chain: pendingPkg.chain,
        handle: pendingPkg.handle || undefined,
      })
      if (pendingPkg.historyBackupBaseUrl) {
        setHistoryBackupPrefs({ baseUrl: pendingPkg.historyBackupBaseUrl })
      }
      setPendingPkg(null)
      setScanPassword('')
      playWalletSound('unlock')
      toastSuccess('Connected', unlocked.record.handle)
      window.location.reload()
    } catch (err) {
      playWalletSound('error')
      toastError('Connect failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="link-device"
      data-aeon-state={qrDataUrl ? 'showing' : pendingPkg ? 'install' : mode}
    >
      <p className="settings-hint">
        Either device can go first. Show a QR on the device that already has the wallet, or scan a QR
        from the other device (camera). Same Wi‑Fi is not required for the new embedded link.
      </p>

      <div className="auth-mode-switch" role="tablist" aria-label="Link mode">
        <button
          type="button"
          role="tab"
          className="auth-mode-tab"
          aria-selected={mode === 'show'}
          data-aeon-state={mode === 'show' ? 'selected' : 'idle'}
          onClick={() => {
            setMode('show')
            setPendingPkg(null)
          }}
        >
          Show QR
        </button>
        <button
          type="button"
          role="tab"
          className="auth-mode-tab"
          aria-selected={mode === 'scan'}
          data-aeon-state={mode === 'scan' ? 'selected' : 'idle'}
          onClick={() => {
            setMode('scan')
            setQrDataUrl(null)
            setOffer(null)
          }}
        >
          Scan
        </button>
      </div>

      {mode === 'show' && !qrDataUrl ? (
        <>
          <div className="field">
            <label htmlFor="link-device-password">Wallet password</label>
            <input
              id="link-device-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Unlock to create link QR"
              autoComplete="current-password"
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void startShow()}
          >
            {busy ? 'Starting…' : 'Show link QR'}
          </button>
        </>
      ) : null}

      {mode === 'show' && qrDataUrl ? (
        <div className="link-device-qr">
          <img src={qrDataUrl} alt="Device link QR" width={360} height={360} />
          <p className="settings-hint">
            Expires in {secondsLeft}s
            {offer?.handle ? ` · ${offer.handle}` : ''}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setQrDataUrl(null)
              setOffer(null)
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {mode === 'scan' && !pendingPkg ? (
        <>
          <QrScanner active onScan={(text) => void ingestQr(text)} />
          <div className="field">
            <label htmlFor="link-paste">Or paste link payload</label>
            <input
              id="link-paste"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="handcash-link:…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !manual.trim()}
            onClick={() => void ingestQr(manual)}
          >
            Use pasted link
          </button>
        </>
      ) : null}

      {mode === 'scan' && pendingPkg ? (
        <>
          <p className="settings-hint">
            Received <strong>{pendingPkg.handle || pendingPkg.identityKey.slice(0, 12)}</strong>.
            This replaces the vault on this Desktop.
          </p>
          <div className="field">
            <label htmlFor="scan-install-password">Password for this Desktop</label>
            <input
              id="scan-install-password"
              type="password"
              value={scanPassword}
              onChange={(e) => setScanPassword(e.target.value)}
              placeholder="10+ chars, letter and number"
              autoComplete="new-password"
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void finishScanInstall()}
          >
            {busy ? 'Connecting…' : 'Connect wallet'}
          </button>
        </>
      ) : null}
    </div>
  )
}
