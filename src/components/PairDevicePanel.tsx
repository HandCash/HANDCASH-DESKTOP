import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { getActiveWallet } from '../wallet/session'
import {
  buildPairPayload,
  isSameIdentityPeer,
  listDeviceWallets,
  pairPayloadToQrText,
  removePeerDevice,
  subscribeDeviceWallets,
  upsertPeerDevice,
  type DeviceWallet,
} from '../wallet/deviceWallets'
import { verifyAndEnrichPair } from '../wallet/devicePeer'
import { pollDeviceMeshOnce } from '../wallet/deviceMesh'
import {
  createSealedBackupForPeer,
  deviceKeyBackupToQrText,
  getDeviceKeyBackup,
  hasDeviceKeyBackup,
  importSealedDeviceKeyBackup,
  openStoredDeviceKeyBackup,
  removeDeviceKeyBackup,
  subscribeDeviceKeyBackups,
  tryParseDeviceKeyBackupPackage,
  type OpenedDeviceKeyBackup,
} from '../wallet/deviceKeyBackup'
import { takePendingPairScan } from '../wallet/pendingPairScan'
import { copyText } from '../wallet/clipboard'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { DeferredImage } from './DeferredImage'
import { QrScanner } from './QrScanner'
import { SkeletonQr } from './Skeleton'

type WizardStep = 'link' | 'exchange' | 'recover'

/**
 * Link identities (keys may differ) + exchange sealed mutual key backups.
 * History URL sync is not part of this flow.
 */
export function PairDevicePanel() {
  const [step, setStep] = useState<WizardStep>('link')
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [pairText, setPairText] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [password, setPassword] = useState('')
  const [spareQrUrl, setSpareQrUrl] = useState<string | null>(null)
  const [spareText, setSpareText] = useState('')
  const [exchangePeer, setExchangePeer] = useState<DeviceWallet | null>(null)
  const [recoverPeerId, setRecoverPeerId] = useState<string | null>(null)
  const [opened, setOpened] = useState<OpenedDeviceKeyBackup | null>(null)
  const [peers, setPeers] = useState<DeviceWallet[]>(() =>
    listDeviceWallets().filter((w) => !w.isLocal),
  )
  const [, setBackupTick] = useState(0)

  useEffect(() => subscribeDeviceWallets((all) => setPeers(all.filter((w) => !w.isLocal))), [])
  useEffect(() => subscribeDeviceKeyBackups(() => setBackupTick((n) => n + 1)), [])

  const active = getActiveWallet()
  const localIk = active?.identityKey ?? ''

  const refreshQr = async () => {
    const wallet = getActiveWallet()
    if (!wallet) {
      setPairText('')
      setQrUrl(null)
      return
    }
    const status = await window.handcash?.getBridgeStatus?.()
    const lan = status?.devicePeerLanUrls?.[0] ?? null
    const payload = buildPairPayload({
      identityKey: wallet.identityKey,
      address: wallet.address,
      peerBaseUrl: lan,
      platform: window.handcash?.platform,
    })
    const text = pairPayloadToQrText(payload)
    setPairText(text)
    const dataUrl = await QRCode.toDataURL(text, {
      width: 220,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
    setQrUrl(dataUrl)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await refreshQr()
      } catch (err) {
        if (!cancelled) {
          toastError('QR failed', err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const linkFromRaw = async (raw: string, opts?: { fromScan?: boolean }) => {
    const wallet = getActiveWallet()
    if (!wallet) {
      toastError('Locked', 'Unlock this wallet first.')
      return false
    }
    if (busy) return false

    const asBackup = tryParseDeviceKeyBackupPackage(raw)
    if (asBackup) {
      setBusy(true)
      try {
        const pkg = importSealedDeviceKeyBackup(raw)
        toastSuccess('Sealed spare stored', pkg.fromLabel)
        playWalletSound('success')
        setPaste('')
        setScanning(false)
        setStep('link')
        return true
      } catch (err) {
        playWalletSound('error')
        toastError('Import failed', err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setBusy(false)
      }
    }

    setBusy(true)
    playWalletSound('soft')
    try {
      const enriched = await verifyAndEnrichPair(raw, wallet.identityKey)
      const peer = upsertPeerDevice({
        deviceId: enriched.deviceId,
        label: enriched.label,
        platform: enriched.platform,
        peerBaseUrl: enriched.peerBaseUrl ?? null,
        identityKey: enriched.identityKey,
        address: enriched.v === 3 ? enriched.address : null,
        lastSeenAt: Date.now(),
        online: enriched.online,
      })
      void pollDeviceMeshOnce()
      setPaste('')
      setScanning(false)
      const sameIk = peer.identityKey.toLowerCase() === wallet.identityKey.toLowerCase()
      if (sameIk) {
        toastSuccess(
          opts?.fromScan ? 'Scanned & linked' : 'Device linked',
          'Same keys on both devices — sealed spare not needed.',
        )
        setStep('link')
      } else {
        setExchangePeer(peer)
        setStep('exchange')
        toastSuccess(
          opts?.fromScan ? 'Identities linked' : 'Identities linked',
          'Next: exchange sealed spare keys.',
        )
      }
      playWalletSound('success')
      return true
    } catch (err) {
      playWalletSound('error')
      toastError('Link failed', err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const pending = takePendingPairScan()
    if (!pending) return
    setPaste(pending)
    void linkFromRaw(pending, { fromScan: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const makeSpareForPeer = async (peer: DeviceWallet) => {
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Password required', 'Confirm your unlock password to seal a spare.')
      return
    }
    setBusy(true)
    playWalletSound('soft')
    try {
      const pkg = await createSealedBackupForPeer({
        password,
        peerIdentityKey: peer.identityKey,
        label: listDeviceWallets().find((w) => w.isLocal)?.label,
      })
      const text = deviceKeyBackupToQrText(pkg)
      setSpareText(text)
      const dataUrl = await QRCode.toDataURL(text, {
        width: 220,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      })
      setSpareQrUrl(dataUrl)
      toastSuccess('Spare sealed', 'Show this QR on the other device to import.')
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      toastError('Seal failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const importSpare = async () => {
    if (!paste.trim()) return
    setBusy(true)
    try {
      const pkg = importSealedDeviceKeyBackup(paste)
      setPaste('')
      toastSuccess('Sealed spare stored', `${pkg.fromLabel} · cold only`)
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      toastError('Import failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runRecover = async () => {
    if (!recoverPeerId) return
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Password required', 'Unlock password opens the sealed spare.')
      return
    }
    setBusy(true)
    try {
      const result = await openStoredDeviceKeyBackup({
        peerDeviceId: recoverPeerId,
        password,
      })
      setOpened(result)
      playWalletSound('success')
      toastSuccess('Spare opened', 'Copy the phrase onto a new device — do not spend from both.')
    } catch (err) {
      playWalletSound('error')
      toastError('Recover failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const hint = useMemo(() => {
    if (step === 'exchange') {
      return 'Each device seals its own keys to the other (cold spare). Neither can spend the other’s coins until you explicitly recover.'
    }
    if (step === 'recover') {
      return 'Opens the sealed spare for the lost device. Restore that phrase on a new install — this device keeps its own wallet.'
    }
    return 'Show this QR on one device. On the other, Scan to link identities. Different keys are fine — then exchange sealed spares.'
  }, [step])

  if (scanning) {
    return (
      <div className="pair-device-block" data-aeon-scope="pair-device" data-aeon-state="scanning">
        <h3 className="settings-row-label" style={{ marginTop: 8 }}>
          Scan to link
        </h3>
        <QrScanner
          hint="Point at the other device’s link QR or sealed-spare QR"
          onCancel={() => {
            playWalletSound('soft')
            setScanning(false)
          }}
          onScan={(raw) => {
            void linkFromRaw(raw, { fromScan: true })
          }}
        />
      </div>
    )
  }

  if (step === 'recover' && recoverPeerId) {
    const peer = peers.find((p) => p.deviceId === recoverPeerId)
    const stored = getDeviceKeyBackup(recoverPeerId)
    return (
      <div className="pair-device-block" data-aeon-scope="pair-device" data-aeon-state="recover">
        <h3 className="settings-row-label" style={{ marginTop: 8 }}>
          Recover {peer?.label ?? stored?.fromLabel ?? 'device'}
        </h3>
        <p className="settings-hint">{hint}</p>
        {!opened ? (
          <>
            <div className="field" data-aeon-part="field" style={{ marginTop: 12 }}>
              <label htmlFor="recover-password">Unlock password (this device)</label>
              <input
                id="recover-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
                onClick={() => void runRecover()}
              >
                {busy ? 'Opening…' : 'Open sealed spare'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setStep('link')
                  setRecoverPeerId(null)
                  setOpened(null)
                  setPassword('')
                }}
              >
                Back
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-row-desc" style={{ marginTop: 12 }}>
              Identity {opened.identityKey.slice(0, 12)}… · {opened.address}
            </p>
            {opened.mnemonic ? (
              <div className="field" data-aeon-part="field" style={{ marginTop: 8 }}>
                <label htmlFor="recover-phrase">Recovery phrase</label>
                <textarea
                  id="recover-phrase"
                  rows={3}
                  readOnly
                  value={opened.mnemonic}
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="field" data-aeon-part="field" style={{ marginTop: 8 }}>
                <label htmlFor="recover-root">Emergency key</label>
                <textarea
                  id="recover-root"
                  rows={3}
                  readOnly
                  value={opened.rootKeyHex}
                  spellCheck={false}
                />
              </div>
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  void copyText(opened.mnemonic ?? opened.rootKeyHex, {
                    label: opened.mnemonic ? 'recovery phrase' : 'emergency key',
                  })
                }
              >
                Copy
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setOpened(null)
                  setPassword('')
                  setStep('link')
                  setRecoverPeerId(null)
                }}
              >
                Done
              </button>
            </div>
            <p className="settings-row-desc" style={{ marginTop: 8 }}>
              On a new device: Restore → Phrase (or emergency key). Then unlink the lost device here.
            </p>
          </>
        )}
      </div>
    )
  }

  if (step === 'exchange' && exchangePeer) {
    return (
      <div className="pair-device-block" data-aeon-scope="pair-device" data-aeon-state="exchange">
        <h3 className="settings-row-label" style={{ marginTop: 8 }}>
          Exchange sealed spares
        </h3>
        <p className="settings-hint">{hint}</p>
        <p className="settings-row-desc" style={{ marginTop: 8 }}>
          Linked: <strong>{exchangePeer.label}</strong>
          {hasDeviceKeyBackup(exchangePeer.deviceId) ? ' · their spare stored here' : ''}
        </p>

        <div className="field" data-aeon-part="field" style={{ marginTop: 12 }}>
          <label htmlFor="seal-password">Unlock password (seal your spare)</label>
          <input
            id="seal-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
            onClick={() => void makeSpareForPeer(exchangePeer)}
          >
            {busy ? 'Sealing…' : 'Create my sealed spare'}
          </button>
        </div>

        {spareQrUrl ? (
          <div className="identity-layout link-device-qr" style={{ marginTop: 16 }}>
            <div className="identity-qr">
              <p className="settings-row-desc" style={{ marginBottom: 8 }}>
                Their device scans this
              </p>
              <DeferredImage
                src={spareQrUrl}
                alt="Sealed spare QR"
                width={180}
                height={180}
                skeletonWidth={180}
                skeletonHeight={180}
                skeletonRadius={4}
                skeletonClassName="skeleton-qr"
              />
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!spareText}
                  onClick={() => void copyText(spareText, { label: 'sealed spare' })}
                >
                  Copy spare code
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="field" data-aeon-part="field" style={{ marginTop: 16 }}>
          <label htmlFor="spare-paste">Import their sealed spare</label>
          <textarea
            id="spare-paste"
            rows={3}
            value={paste}
            placeholder="Paste their sealed spare JSON, or Scan"
            onChange={(e) => setPaste(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              playWalletSound('soft')
              setScanning(true)
            }}
          >
            Scan their spare
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !paste.trim()}
            onClick={() => void importSpare()}
          >
            Import from paste
          </button>
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setStep('link')
              setExchangePeer(null)
              setSpareQrUrl(null)
              setSpareText('')
              setPassword('')
              toastSuccess(
                'Link saved',
                hasDeviceKeyBackup(exchangePeer.deviceId)
                  ? 'Identity linked · sealed spare stored'
                  : 'Identity linked — add a sealed spare anytime from the list below',
              )
            }}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pair-device-block" data-aeon-scope="pair-device">
      <h3 className="settings-row-label" style={{ marginTop: 8 }}>
        Link another device
      </h3>
      <p className="settings-hint">{hint}</p>

      <div className="identity-layout link-device-qr" style={{ marginTop: 16 }}>
        <div className="identity-qr">
          <p className="settings-row-desc" style={{ marginBottom: 8 }}>
            This device’s link QR
          </p>
          {qrUrl ? (
            <DeferredImage
              src={qrUrl}
              alt="Device link QR"
              width={180}
              height={180}
              skeletonWidth={180}
              skeletonHeight={180}
              skeletonRadius={4}
              skeletonClassName="skeleton-qr"
            />
          ) : (
            <SkeletonQr size={180} />
          )}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!pairText}
              onClick={() => void copyText(pairText, { label: 'pair code' })}
            >
              Copy pair code
            </button>
          </div>
        </div>

        <div className="identity-info">
          <p className="settings-row-desc" style={{ marginBottom: 8 }}>
            Other device
          </p>
          <div className="actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                playWalletSound('soft')
                setScanning(true)
              }}
            >
              Scan to link
            </button>
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="pair-paste">Or paste their pair / spare code</label>
            <textarea
              id="pair-paste"
              rows={4}
              value={paste}
              placeholder='{"v":3,"identityKey":"…","address":"…"}'
              onChange={(e) => setPaste(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !paste.trim()}
              onClick={() => void linkFromRaw(paste)}
            >
              {busy ? 'Working…' : 'Link / import'}
            </button>
          </div>
        </div>
      </div>

      {peers.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <h3 className="settings-row-label">Linked devices</h3>
          <ul className="settings-hint" style={{ paddingLeft: '1.25rem', marginTop: 8 }}>
            {peers.map((p) => {
              const spare = hasDeviceKeyBackup(p.deviceId)
              const same = localIk ? isSameIdentityPeer(p, localIk) : false
              return (
                <li key={p.deviceId} style={{ marginBottom: 12 }}>
                  <strong>{p.label}</strong>
                  {same ? ' · same keys' : ' · linked identity'}
                  {spare ? ' · sealed spare here' : same ? '' : ' · no spare yet'}
                  <div className="actions" style={{ marginTop: 6 }}>
                    {!same ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          playWalletSound('soft')
                          setExchangePeer(p)
                          setSpareQrUrl(null)
                          setSpareText('')
                          setPassword('')
                          setStep('exchange')
                        }}
                      >
                        {spare ? 'Update spare' : 'Exchange spare'}
                      </button>
                    ) : null}
                    {spare ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          playWalletSound('soft')
                          setRecoverPeerId(p.deviceId)
                          setOpened(null)
                          setPassword('')
                          setStep('recover')
                        }}
                      >
                        Recover
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        playWalletSound('soft')
                        removePeerDevice(p.deviceId)
                        removeDeviceKeyBackup(p.deviceId)
                        toastSuccess('Removed', p.label)
                      }}
                    >
                      Unlink
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
