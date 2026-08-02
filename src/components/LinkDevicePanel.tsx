import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import {
  encodePairingQr,
  encryptPairingPackage,
  randomKeyHex,
  type PairingOffer,
} from '../wallet/deviceLinkProtocol'
import { getHistoryBackupPrefs } from '../wallet/historyBackupPrefs'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { revealRootKeyHex, readVaultMeta } from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'

const TTL_MS = 120_000

export function LinkDevicePanel() {
  const meta = readVaultMeta()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (!offer) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        void window.handcash?.stopDeviceLink?.()
        setQrDataUrl(null)
        setOffer(null)
      }
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [offer])

  useEffect(() => {
    return () => {
      void window.handcash?.stopDeviceLink?.()
    }
  }, [])

  const start = async () => {
    if (!window.handcash?.startDeviceLink) {
      toastError('Device link requires the Desktop app')
      return
    }
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Enter your wallet password')
      return
    }
    setBusy(true)
    try {
      const rootKeyHex = await revealRootKeyHex(password)
      const sessionId = randomKeyHex(16)
      const keyHex = randomKeyHex(32)
      const historyBackupBaseUrl = getHistoryBackupPrefs().baseUrl
      const enc = await encryptPairingPackage(
        {
          v: 1,
          rootKeyHex,
          handle: meta?.handle ?? '',
          identityKey: meta?.identityKey ?? '',
          address: meta?.address ?? '',
          chain: meta?.chain ?? 'main',
          historyBackupBaseUrl,
          createdAt: Date.now(),
        },
        keyHex,
      )
      const host = await window.handcash.startDeviceLink({
        sessionId,
        ivHex: enc.ivHex,
        ciphertextHex: enc.ciphertextHex,
        ttlMs: TTL_MS,
      })
      if (!host.ok) throw new Error(host.error)
      const nextOffer: PairingOffer = {
        v: 1,
        baseUrl: host.baseUrl,
        sessionId: host.sessionId,
        keyHex,
        expiresAt: host.expiresAt,
        handle: meta?.handle,
      }
      const qrText = encodePairingQr(nextOffer)
      const dataUrl = await QRCode.toDataURL(qrText, {
        margin: 1,
        width: 280,
        color: { dark: '#000000', light: '#ffffff' },
      })
      setOffer(nextOffer)
      setQrDataUrl(dataUrl)
      setPassword('')
      playWalletSound('soft')
      toastSuccess('Scan with HandCash mobile')
    } catch (err) {
      playWalletSound('error')
      toastError('Could not start link', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    void window.handcash?.stopDeviceLink?.()
    setQrDataUrl(null)
    setOffer(null)
    playWalletSound('soft')
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="link-device"
      data-aeon-state={qrDataUrl ? 'active' : 'idle'}
    >
      <p className="settings-hint">
        Telegram-style login: show a QR on this Desktop. On the same Wi‑Fi, open HandCash mobile →
        Scan to link. The phone receives this wallet and uses your history sync URL when set.
      </p>

      {!qrDataUrl ? (
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
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : 'Show link QR'}
          </button>
        </>
      ) : (
        <div className="link-device-qr">
          <img src={qrDataUrl} alt="Device link QR" width={280} height={280} />
          <p className="settings-hint">
            Expires in {secondsLeft}s
            {offer?.handle ? ` · ${offer.handle}` : ''}
            {offer ? (
              <>
                <br />
                <span className="mono">{offer.baseUrl}</span>
              </>
            ) : null}
          </p>
          <button type="button" className="btn btn-ghost" onClick={stop}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
