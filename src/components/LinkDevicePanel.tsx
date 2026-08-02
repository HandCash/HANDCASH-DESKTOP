import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { applyLinkedWallet } from '../wallet/applyLinkedWallet'
import {
  LINK_FLASH_FPS,
  LinkQrAssembler,
  createLinkFlashSession,
  isLinkQrPayload,
  packageWithHistory,
  type LinkAssembleProgress,
  type LinkFlashSession,
  type PairingPackage,
} from '../wallet/deviceLinkProtocol'
import { createBrc39BackupBytes } from '../wallet/historyBackup'
import { getHistoryBackupPrefs } from '../wallet/historyBackupPrefs'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { hasVault, readVaultMeta, revealRootKeyHex } from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { QrScanner } from './QrScanner'

const TTL_MS = 180_000

type Mode = 'show' | 'scan'

export function LinkDevicePanel() {
  const meta = readVaultMeta()
  const [mode, setMode] = useState<Mode>('show')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<LinkFlashSession | null>(null)
  const [flashIndex, setFlashIndex] = useState(0)
  const [flashDataUrl, setFlashDataUrl] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [manual, setManual] = useState('')
  const [scanPassword, setScanPassword] = useState('')
  const [pendingPkg, setPendingPkg] = useState<PairingPackage | null>(null)
  const [receiveProgress, setReceiveProgress] = useState<LinkAssembleProgress | null>(null)
  const assemblerRef = useRef(new LinkQrAssembler())

  useEffect(() => {
    if (!flash) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((flash.expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        setFlash(null)
        setFlashDataUrl(null)
      }
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [flash])

  // Cycle QR frames for the multi-code transfer.
  useEffect(() => {
    if (!flash || flash.frames.length === 0) return
    let cancelled = false
    let i = 0
    const paint = async (index: number) => {
      try {
        const dataUrl = await QRCode.toDataURL(flash.frames[index]!, {
          margin: 2,
          width: 512,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'L',
        })
        if (!cancelled) {
          setFlashIndex(index)
          setFlashDataUrl(dataUrl)
        }
      } catch (err) {
        console.warn('[link] frame render failed', err)
      }
    }
    void paint(0)
    const id = window.setInterval(() => {
      i = (i + 1) % flash.frames.length
      void paint(i)
    }, Math.round(1000 / LINK_FLASH_FPS))
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [flash])

  const startShow = async () => {
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Enter your wallet password')
      return
    }
    setBusy(true)
    try {
      const base = {
        rootKeyHex: '', // filled below via packageWithHistory path
        handle: meta?.handle ?? '',
        identityKey: meta?.identityKey ?? '',
        address: meta?.address ?? '',
        chain: (meta?.chain ?? 'main') as 'main' | 'test',
        historyBackupBaseUrl: getHistoryBackupPrefs().baseUrl,
        createdAt: Date.now(),
      }

      // Export history first (needs unlocked storage + password).
      let pkg: PairingPackage
      try {
        const rootKeyHex = await revealRootKeyHex(password)
        const brc39 = await createBrc39BackupBytes(password)
        pkg = packageWithHistory({ ...base, rootKeyHex }, brc39, password)
      } catch (err) {
        console.warn('[link] history export failed — keys only', err)
        const rootKeyHex = await revealRootKeyHex(password)
        pkg = {
          v: 1,
          ...base,
          rootKeyHex,
        }
        toastError(
          'History export failed',
          'Sending keys only — balance may need Refresh / History restore on the other device.',
        )
      }

      const session = await createLinkFlashSession(pkg, TTL_MS)
      setFlash(session)
      setPassword('')
      playWalletSound('soft')
      toastSuccess(
        session.hasHistory ? 'Point the other device at the flashing QR' : 'Scan the flashing QR',
        `${session.frameCount} frames`,
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Could not create link QR', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ingestQr = async (text: string) => {
    const raw = text.trim()
    if (!isLinkQrPayload(raw)) return
    if (pendingPkg) return
    try {
      const pkg = await assemblerRef.current.ingest(raw)
      setReceiveProgress(assemblerRef.current.progress)
      if (!pkg) return
      setPendingPkg(pkg)
      playWalletSound('soft')
      toastSuccess(
        pkg.brc39Base64 ? 'Wallet + history received' : 'Wallet keys received',
        'Set a password for this device',
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Invalid link', err instanceof Error ? err.message : String(err))
      assemblerRef.current.reset()
      setReceiveProgress(null)
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
        toastError('Wipe this wallet first, or use Show QR to send it to the other device')
        return
      }
    }
    setBusy(true)
    try {
      const { unlocked, historyRestored } = await applyLinkedWallet(pendingPkg, scanPassword)
      setPendingPkg(null)
      setScanPassword('')
      assemblerRef.current.reset()
      playWalletSound('unlock')
      toastSuccess(
        'Connected',
        historyRestored
          ? `${unlocked.record.handle || 'wallet'} · history restored`
          : unlocked.record.handle,
      )
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
      data-aeon-state={flash ? 'showing' : pendingPkg ? 'install' : mode}
    >
      <p className="settings-hint">
        Show a flashing QR on the device that has the wallet. The other device scans until all
        frames are received — keys and spendable history transfer together (no Wi‑Fi needed).
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
            assemblerRef.current.reset()
            setReceiveProgress(null)
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
            setFlash(null)
            setFlashDataUrl(null)
          }}
        >
          Scan
        </button>
      </div>

      {mode === 'show' && !flash ? (
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
            {busy ? 'Packing wallet…' : 'Show link QR'}
          </button>
        </>
      ) : null}

      {mode === 'show' && flash && flashDataUrl ? (
        <div className="link-device-qr">
          <img src={flashDataUrl} alt="Device link QR frame" width={360} height={360} />
          <p className="settings-hint">
            Frame {flashIndex + 1}/{flash.frameCount}
            {flash.hasHistory ? ' · includes history' : ' · keys only'}
            {' · '}expires in {secondsLeft}s
            {flash.handle ? ` · ${flash.handle}` : ''}
          </p>
          <p className="settings-hint">Keep this screen bright and hold the other camera steady.</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setFlash(null)
              setFlashDataUrl(null)
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {mode === 'scan' && !pendingPkg ? (
        <>
          <QrScanner active dedupeMs={400} onScan={(text) => void ingestQr(text)} />
          {receiveProgress && receiveProgress.total > 0 ? (
            <p className="settings-hint link-receive-progress">
              Receiving {receiveProgress.have}/{receiveProgress.total} frames…
            </p>
          ) : (
            <p className="settings-hint">Aim at the flashing QR — frames can arrive in any order.</p>
          )}
          <div className="field">
            <label htmlFor="link-paste">Or paste a single-frame link payload</label>
            <input
              id="link-paste"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="handcash-link:… or handcash-link3:…"
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
            Received <strong>{pendingPkg.handle || pendingPkg.identityKey.slice(0, 12)}</strong>
            {pendingPkg.brc39Base64 ? ' with spendable history' : ' (keys only)'}. This replaces the
            vault on this device.
          </p>
          <div className="field">
            <label htmlFor="scan-install-password">Password for this device</label>
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
