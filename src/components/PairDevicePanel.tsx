import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { getActiveWallet } from '../wallet/session'
import {
  buildPairPayload,
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
  hasDeviceLinkBackupUrl,
  syncDevicesViaBackupUrl,
} from '../wallet/deviceSync'
import { recomposeWallet } from '../wallet/recompose'
import {
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
  setHistoryBackupPrefs,
} from '../wallet/historyBackupPrefs'
import { openSetting } from '../wallet/navStore'
import { copyText } from '../wallet/clipboard'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { DeferredImage } from './DeferredImage'
import { SkeletonQr } from './Skeleton'

/**
 * Link devices: same identity + same BRC-39 backup URL (required).
 * QR carries backupBaseUrl; mismatch rejects. Sync = pull/push BRC-39 + friends.
 */
export function PairDevicePanel() {
  const [backupUrl, setBackupUrl] = useState(() => resolveHistoryBackupBaseUrl())
  const [urlDraft, setUrlDraft] = useState(backupUrl)
  const [password, setPassword] = useState('')
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [pairText, setPairText] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [peers, setPeers] = useState<DeviceWallet[]>(() =>
    listDeviceWallets().filter((w) => !w.isLocal),
  )

  useEffect(() => subscribeDeviceWallets((all) => setPeers(all.filter((w) => !w.isLocal))), [])

  const refreshQr = async () => {
    const active = getActiveWallet()
    if (!active || !hasDeviceLinkBackupUrl()) {
      setPairText('')
      setQrUrl(null)
      return
    }
    const status = await window.handcash?.getBridgeStatus?.()
    const lan = status?.devicePeerLanUrls?.[0] ?? null
    const payload = buildPairPayload({
      identityKey: active.identityKey,
      backupBaseUrl: resolveHistoryBackupBaseUrl(),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupUrl])

  const saveUrl = () => {
    const next = setHistoryBackupPrefs({ baseUrl: urlDraft })
    setBackupUrl(next.baseUrl)
    playWalletSound('soft')
    toastSuccess(next.baseUrl ? 'Backup URL saved' : 'Backup URL cleared')
  }

  const pairFromPaste = async () => {
    const active = getActiveWallet()
    if (!active) {
      toastError('Locked', 'Unlock this wallet first.')
      return
    }
    if (!hasDeviceLinkBackupUrl()) {
      toastError('Backup URL required', 'Set the same History URL on both devices first.')
      return
    }
    if (busy) return
    setBusy(true)
    playWalletSound('soft')
    try {
      const enriched = await verifyAndEnrichPair(paste, active.identityKey)
      upsertPeerDevice({
        deviceId: enriched.deviceId,
        label: enriched.label,
        platform: enriched.platform,
        peerBaseUrl: enriched.peerBaseUrl ?? null,
        identityKey: enriched.identityKey,
        lastSeenAt: Date.now(),
        online: enriched.online,
      })
      void pollDeviceMeshOnce()
      setPaste('')
      toastSuccess(
        'Device linked',
        'Same backup URL — use Sync below so wallet history and friends match.',
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Link failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runSync = async () => {
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Password required', 'Same unlock password encrypts the BRC-39 blob on both devices.')
      return
    }
    setBusy(true)
    playWalletSound('soft')
    try {
      const result = await syncDevicesViaBackupUrl(password)
      const recomposed = await recomposeWallet({
        password,
        history: 'skip',
        reason: 'pair-sync',
      })
      const parts = [
        result.pulled
          ? result.brc39
            ? `history ${result.brc39.inserts + result.brc39.updates} changes`
            : 'history pulled'
          : result.skippedPullReason
            ? `kept local history (${result.skippedPullReason})`
            : 'kept local history',
        result.friendsMerged ? `${result.friendsMerged} friends added` : null,
        result.uploaded ? 'uploaded' : null,
        recomposed.spendableSats != null ? `chain ${recomposed.spendableSats} sats` : null,
      ].filter(Boolean)
      toastSuccess('Devices synced', parts.join(' · '))
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      toastError('Sync failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const hint = useMemo(() => {
    if (!backupUrl) {
      return 'Set the same History backup URL on every device. Linking will not work without it.'
    }
    return `Linked devices share ${backupUrl} for BRC-39 history + friends. Use the same unlock password on both.`
  }, [backupUrl])

  return (
    <div className="pair-device-block" data-aeon-scope="pair-device">
      <h3 className="settings-row-label" style={{ marginTop: 8 }}>
        Link devices (shared backup URL)
      </h3>
      <p className="settings-hint">{hint}</p>

      <div className="field" data-aeon-part="field" style={{ marginTop: 12 }}>
        <label htmlFor="device-backup-url">History backup URL (required)</label>
        <input
          id="device-backup-url"
          type="url"
          placeholder="https://…"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-primary" onClick={saveUrl}>
          Save URL
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            playWalletSound('soft')
            openSetting('history-backup')
          }}
        >
          History settings
        </button>
      </div>

      {!backupUrl ? (
        <p className="settings-row-desc" style={{ marginTop: 12 }}>
          Save a URL above before pairing. Both devices must use the exact same base URL.
        </p>
      ) : (
        <>
          <div className="identity-layout" style={{ marginTop: 16 }}>
            <div className="identity-qr">
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
              <div className="field" data-aeon-part="field">
                <label htmlFor="pair-paste">Paste their pair code</label>
                <textarea
                  id="pair-paste"
                  rows={5}
                  value={paste}
                  placeholder='{"v":2,"backupBaseUrl":"https://…","identityKey":"…"}'
                  onChange={(e) => setPaste(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !paste.trim()}
                  onClick={() => void pairFromPaste()}
                >
                  {busy ? 'Linking…' : 'Link device'}
                </button>
              </div>
            </div>
          </div>

          <div className="field" data-aeon-part="field" style={{ marginTop: 16 }}>
            <label htmlFor="device-sync-password">Password (sync history)</label>
            <input
              id="device-sync-password"
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
              onClick={() => void runSync()}
            >
              {busy ? 'Syncing…' : 'Sync via backup URL'}
            </button>
          </div>
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            Pulls history only if the cloud copy is newer than this device, then uploads. Last upload:{' '}
            {getHistoryBackupPrefs().lastUploadedAt
              ? new Date(getHistoryBackupPrefs().lastUploadedAt!).toLocaleString()
              : 'never'}
            .
          </p>
        </>
      )}

      {peers.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <h3 className="settings-row-label">Linked devices</h3>
          <ul className="settings-hint" style={{ paddingLeft: '1.25rem', marginTop: 8 }}>
            {peers.map((p) => (
              <li key={p.deviceId} style={{ marginBottom: 8 }}>
                {p.label}
                {p.online ? ' · LAN online' : ''}
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    playWalletSound('soft')
                    removePeerDevice(p.deviceId)
                    toastSuccess('Removed', p.label)
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
