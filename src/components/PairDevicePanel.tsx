import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useMachine } from '@xstate/react'
import { ListRow, StatusBanner } from '@aeon-ui/react'
import { getActiveWallet } from '../wallet/session'
import {
  buildPairPayload,
  choosePairAcceptancePath,
  isSameIdentityPeer,
  listDeviceWallets,
  parsePairPayload,
  pairPayloadToQrText,
  removePeerDevice,
  subscribeDeviceWallets,
  upsertPeerDevice,
  upsertPeerFromSealedBackup,
  type DeviceWallet,
} from '../wallet/deviceWallets'
import { verifyAndEnrichPair } from '../wallet/devicePeer'
import { pollDeviceMeshOnce } from '../wallet/deviceMesh'
import {
  clearSpareExchangeForPeer,
  createSealedBackupForPeer,
  deviceKeyBackupToQrText,
  getDeviceBackupRoleStatus,
  getDeviceKeyBackup,
  importSealedDeviceKeyBackup,
  openStoredDeviceKeyBackup,
  subscribeDeviceKeyBackups,
  tryParseDeviceKeyBackupPackage,
  type DeviceBackupRoleStatus,
  type OpenedDeviceKeyBackup,
} from '../wallet/deviceKeyBackup'
import { createQrFrameAssembler, parseQrFrame } from '../wallet/qrFrames'
import { deviceBackupMachine } from '../machines/deviceBackupMachine'
import {
  backedUpToTitle,
  groupDeviceBackups,
  storingTitle,
} from '../wallet/deviceBackupGroups'
import { takePendingPairScan } from '../wallet/pendingPairScan'
import { copyText } from '../wallet/clipboard'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { AnimatedQr } from './AnimatedQr'
import { DeferredImage } from './DeferredImage'
import { EmptyState } from './EmptyState'
import { QrScanner } from './QrScanner'
import { SkeletonQr } from './Skeleton'
import { ScanQrIcon } from './icons'

/** Detail-screen status. The list itself gets its meaning from section headers. */
function directionLabel(peer: DeviceWallet, role: DeviceBackupRoleStatus, same: boolean): string {
  if (same) return 'Same wallet · no copy needed'
  switch (role.direction) {
    case 'reciprocal':
      return 'Both sides hold a copy — unsafe'
    case 'this-wallet-to-peer':
      return `This wallet is backed up to ${peer.label}`
    case 'peer-wallet-to-this-device':
      return role.protectsPeer
        ? `This wallet is storing ${peer.label}’s backup`
        : `${peer.label}’s backup is missing`
    default:
      return 'No copy either way yet'
  }
}

/**
 * In a section whose heading already states the direction, the row should add
 * something new — the platform — instead of repeating the heading.
 */
function platformLabel(peer: DeviceWallet): string {
  const raw = (peer.platform ?? '').trim().toLowerCase()
  switch (raw) {
    case 'darwin':
    case 'mac':
      return 'Mac'
    case 'win32':
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'android':
      return 'Android'
    case 'ios':
      return 'iPhone or iPad'
    default:
      return raw ? raw.replace(/^./, (c) => c.toUpperCase()) : 'Device'
  }
}

function roleTone(role: DeviceBackupRoleStatus): 'ok' | 'warn' | 'idle' {
  if (role.direction === 'reciprocal') return 'warn'
  if (role.direction === 'none') return 'idle'
  return 'ok'
}

/**
 * Link devices, then give exactly one of the two wallets a sealed recovery copy.
 * Projection of `deviceBackupMachine`.
 */
export function PairDevicePanel() {
  const [snapshot, send] = useMachine(deviceBackupMachine)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [pairText, setPairText] = useState('')
  const [paste, setPaste] = useState('')
  const [password, setPassword] = useState('')
  const [spareText, setSpareText] = useState('')
  const [opened, setOpened] = useState<OpenedDeviceKeyBackup | null>(null)
  const [linkedNotice, setLinkedNotice] = useState(false)
  const [showPaste, setShowPaste] = useState(false)
  const [peers, setPeers] = useState<DeviceWallet[]>(() =>
    listDeviceWallets().filter((w) => !w.isLocal),
  )
  const [, setBackupTick] = useState(0)
  const frameAssemblerRef = useRef(createQrFrameAssembler())

  useEffect(() => subscribeDeviceWallets((all) => setPeers(all.filter((w) => !w.isLocal))), [])
  useEffect(() => subscribeDeviceKeyBackups(() => setBackupTick((n) => n + 1)), [])

  const active = getActiveWallet()
  const localIk = active?.identityKey ?? ''
  const backupGroups = groupDeviceBackups(peers, localIk, getDeviceBackupRoleStatus)
  const { peerDeviceId, showMyCode, error } = snapshot.context
  const peer = peers.find((p) => p.deviceId === peerDeviceId) ?? null
  const busy =
    snapshot.matches({ device: 'sealing' }) ||
    snapshot.matches({ device: 'importing' }) ||
    snapshot.matches({ recovery: 'unsealing' })

  useEffect(() => {
    if (!showMyCode || qrUrl) return
    let cancelled = false
    void (async () => {
      const wallet = getActiveWallet()
      if (!wallet) return
      const status = await window.handcash?.getBridgeStatus?.()
      const text = pairPayloadToQrText(
        buildPairPayload({
          identityKey: wallet.identityKey,
          address: wallet.address,
          peerBaseUrl: status?.devicePeerLanUrls?.[0] ?? null,
          platform: window.handcash?.platform,
        }),
      )
      const dataUrl = await QRCode.toDataURL(text, {
        width: 220,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      })
      if (cancelled) return
      setPairText(text)
      setQrUrl(dataUrl)
    })().catch((err) => {
      if (!cancelled) toastError('QR failed', err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
    }
  }, [showMyCode, qrUrl])

  const addFromRaw = async (raw: string) => {
    const wallet = getActiveWallet()
    if (!wallet) {
      toastError('Locked', 'Unlock this wallet first.')
      return
    }
    if (busy) return

    const asBackup = tryParseDeviceKeyBackupPackage(raw)
    if (asBackup) {
      try {
        const pkg = importSealedDeviceKeyBackup(raw)
        upsertPeerFromSealedBackup(pkg)
        setPaste('')
        setLinkedNotice(false)
        send({ type: 'SCANNED', peerDeviceId: pkg.fromDeviceId })
        toastSuccess('Copy stored', `This wallet can now restore ${pkg.fromLabel}.`)
        playWalletSound('success')
      } catch (err) {
        playWalletSound('error')
        send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
        toastError('Import failed', err instanceof Error ? err.message : String(err))
      }
      return
    }

    try {
      const parsed = parsePairPayload(raw)
      const acceptance = choosePairAcceptancePath(parsed, wallet.identityKey)
      if (acceptance.path === 'refuse') throw new Error('That is this device')

      if (acceptance.path === 'backup-only') {
        const added = upsertPeerDevice({
          deviceId: parsed.deviceId,
          label: parsed.label,
          platform: parsed.platform,
          peerBaseUrl: null,
          identityKey: parsed.identityKey,
          address: parsed.v === 3 ? parsed.address : null,
          lastSeenAt: Date.now(),
          online: false,
        })
        setPaste('')
        setLinkedNotice(true)
        send({ type: 'SCANNED', peerDeviceId: added.deviceId })
        toastSuccess('Linked', added.label)
        playWalletSound('success')
        return
      }

      const enriched = await verifyAndEnrichPair(raw, wallet.identityKey)
      upsertPeerDevice({
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
      setLinkedNotice(true)
      send({ type: 'SCANNED', peerDeviceId: enriched.deviceId })
      toastSuccess('Same wallet', 'Both devices hold these keys already.')
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      toastError('Could not add', err instanceof Error ? err.message : String(err))
    }
  }

  const ingestScan = (raw: string): boolean => {
    if (parseQrFrame(raw)) {
      const result = frameAssemblerRef.current.add(raw)
      if (!result?.complete) return false
      frameAssemblerRef.current.reset()
      void addFromRaw(result.payload)
      return true
    }
    void addFromRaw(raw)
    return true
  }

  useEffect(() => {
    const pending = takePendingPairScan()
    if (pending) void addFromRaw(pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** A device removed elsewhere must not leave its own screen on stage. */
  useEffect(() => {
    if (snapshot.matches('device') && !peer) send({ type: 'BACK' })
  }, [snapshot, peer, send])

  const sealForPeer = async () => {
    if (!peer) return
    send({ type: 'SEAL' })
    try {
      const pkg = await createSealedBackupForPeer({
        password,
        peerIdentityKey: peer.identityKey,
        peerDeviceId: peer.deviceId,
        label: listDeviceWallets().find((w) => w.isLocal)?.label,
      })
      setSpareText(deviceKeyBackupToQrText(pkg))
      setPassword('')
      send({ type: 'SEAL_OK' })
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const importForPeer = async () => {
    if (!paste.trim()) return
    send({ type: 'IMPORT' })
    try {
      const pkg = importSealedDeviceKeyBackup(paste)
      upsertPeerFromSealedBackup(pkg)
      setPaste('')
      setShowPaste(false)
      send({ type: 'IMPORT_OK' })
      toastSuccess('Copy stored', `This wallet can now restore ${pkg.fromLabel}.`)
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const unseal = async () => {
    if (!peerDeviceId) return
    send({ type: 'UNSEAL' })
    try {
      const result = await openStoredDeviceKeyBackup({ peerDeviceId, password })
      setOpened(result)
      setPassword('')
      send({ type: 'UNSEAL_OK' })
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const leave = () => {
    setPassword('')
    setPaste('')
    setSpareText('')
    setOpened(null)
    setLinkedNotice(false)
    setShowPaste(false)
    frameAssemblerRef.current.reset()
    send({ type: 'BACK' })
  }

  if (snapshot.matches('scanning')) {
    return (
      <div className="device-backup" data-aeon-scope="device-backup" data-aeon-state="scanning">
        <QrScanner
          hint="Point at the other device’s code"
          onCancel={() => {
            playWalletSound('soft')
            frameAssemblerRef.current.reset()
            send({ type: 'SCAN_CANCEL' })
          }}
          onScan={(raw) => ingestScan(raw)}
        />
      </div>
    )
  }

  if (snapshot.matches('recovery')) {
    const stored = peerDeviceId ? getDeviceKeyBackup(peerDeviceId) : null
    const name = peer?.label ?? stored?.fromLabel ?? 'device'
    return (
      <div className="device-backup" data-aeon-scope="device-backup" data-aeon-state="recovery">
        <header className="device-backup-head">
          <h3>Restore {name}</h3>
          <p>Enter this on the new device, then remove {name} here.</p>
        </header>

        {error ? (
          <StatusBanner.Root tone="danger" status="recover-failed">
            <StatusBanner.Copy>
              <StatusBanner.Body>{error}</StatusBanner.Body>
            </StatusBanner.Copy>
          </StatusBanner.Root>
        ) : null}

        {opened ? (
          <>
            <div className="field" data-aeon-part="field">
              <label htmlFor="recover-secret">
                {opened.mnemonic ? 'Recovery phrase' : 'Emergency key'}
              </label>
              <textarea
                id="recover-secret"
                rows={3}
                readOnly
                value={opened.mnemonic ?? opened.rootKeyHex}
                spellCheck={false}
              />
            </div>
            <div className="actions">
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
              <button type="button" className="btn btn-ghost" onClick={leave}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field" data-aeon-part="field">
              <label htmlFor="recover-password">Your unlock password</label>
              <input
                id="recover-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
                onClick={() => void unseal()}
              >
                {busy ? 'Opening…' : 'Open copy'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={leave}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  if (snapshot.matches('device') && peer) {
    const role = getDeviceBackupRoleStatus(peer.deviceId)
    const same = localIk ? isSameIdentityPeer(peer, localIk) : false
    const sealing = snapshot.matches({ device: 'sealPrompt' }) || snapshot.matches({ device: 'sealing' })
    const sealed = snapshot.matches({ device: 'sealed' })
    const importing =
      snapshot.matches({ device: 'importPrompt' }) || snapshot.matches({ device: 'importing' })
    const choosing = snapshot.matches({ device: 'choosing' })

    return (
      <div className="device-backup" data-aeon-scope="device-backup" data-aeon-state="device">
        <header className="device-backup-head">
          <h3>Backup</h3>
          <p>{peer.label}</p>
          <p data-aeon-part="direction" data-aeon-state={roleTone(role)}>
            {directionLabel(peer, role, same)}
          </p>
        </header>

        {linkedNotice && choosing ? (
          <StatusBanner.Root tone="success" status="linked">
            <StatusBanner.Copy>
              <StatusBanner.Title>Linked</StatusBanner.Title>
              <StatusBanner.Body>
                {same
                  ? 'Same wallet on both devices — no copy needed.'
                  : 'Pick which wallet gets backed up.'}
              </StatusBanner.Body>
            </StatusBanner.Copy>
          </StatusBanner.Root>
        ) : null}

        {role.direction === 'reciprocal' ? (
          <StatusBanner.Root tone="danger" status="reciprocal">
            <StatusBanner.Copy>
              <StatusBanner.Title>Both wallets are exposed</StatusBanner.Title>
              <StatusBanner.Body>
                Each device can open the other. Delete one copy and move that wallet to a new phrase.
              </StatusBanner.Body>
            </StatusBanner.Copy>
          </StatusBanner.Root>
        ) : null}

        {error ? (
          <StatusBanner.Root tone="danger" status="failed">
            <StatusBanner.Copy>
              <StatusBanner.Body>{error}</StatusBanner.Body>
            </StatusBanner.Copy>
          </StatusBanner.Root>
        ) : null}

        {choosing && !same && role.direction === 'none' ? (
          <ul className="device-backup-choices">
            <li>
              <ListRow.Root
                className="device-backup-row"
                onClick={() => send({ type: 'PROTECT_LOCAL' })}
              >
                <ListRow.Label>Back up this wallet to {peer.label}</ListRow.Label>
                <ListRow.Description>
                  {peer.label} keeps the encrypted copy and can restore this wallet
                </ListRow.Description>
              </ListRow.Root>
            </li>
            <li>
              <ListRow.Root
                className="device-backup-row"
                onClick={() => {
                  setShowPaste(false)
                  send({ type: 'PROTECT_PEER' })
                }}
              >
                <ListRow.Label>Store {peer.label}’s backup on this device</ListRow.Label>
                <ListRow.Description>
                  This wallet keeps the encrypted copy and can restore {peer.label}
                </ListRow.Description>
              </ListRow.Root>
            </li>
          </ul>
        ) : null}

        {sealing ? (
          <>
            <p className="settings-hint">
              Seals this wallet’s keys so only {peer.label} can open the copy.
            </p>
            <div className="field" data-aeon-part="field">
              <label htmlFor="seal-password">Your unlock password</label>
              <input
                id="seal-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
                onClick={() => void sealForPeer()}
              >
                {busy ? 'Sealing…' : 'Create copy'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                Back
              </button>
            </div>
          </>
        ) : null}

        {sealed && spareText ? (
          <div className="device-backup-qr">
            <p>Scan on {peer.label}</p>
            <AnimatedQr value={spareText} alt="Sealed recovery code" size={180} />
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!spareText}
                onClick={() => void copyText(spareText, { label: 'recovery code' })}
              >
                Copy code
              </button>
              <button type="button" className="btn btn-primary" onClick={leave}>
                Done
              </button>
            </div>
          </div>
        ) : null}

        {importing ? (
          <>
            <p className="settings-hint">
              On {peer.label}, choose “Back up this wallet to …”, then scan the animated
              code it shows.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  playWalletSound('soft')
                  send({ type: 'SCAN' })
                }}
              >
                Scan their code
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                Back
              </button>
            </div>
            {showPaste ? (
              <>
                <div className="field" data-aeon-part="field">
                  <label htmlFor="spare-paste">Paste the recovery code</label>
                  <textarea
                    id="spare-paste"
                    rows={3}
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || !paste.trim()}
                    onClick={() => void importForPeer()}
                  >
                    {busy ? 'Storing…' : 'Store copy'}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-ghost device-backup-paste-toggle"
                onClick={() => setShowPaste(true)}
              >
                Paste instead
              </button>
            )}
          </>
        ) : null}

        {choosing ? (
          <div className="actions device-backup-foot">
            {role.protectsPeer ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  playWalletSound('soft')
                  send({ type: 'OPEN_RECOVERY', peerDeviceId: peer.deviceId })
                }}
              >
                Restore {peer.label}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={leave}>
              Back
            </button>
            {/* Destructive last, and set apart from the everyday actions. */}
            <button
              type="button"
              className="btn btn-ghost device-backup-remove"
              onClick={() => {
                playWalletSound('soft')
                removePeerDevice(peer.deviceId)
                clearSpareExchangeForPeer(peer.deviceId)
                toastSuccess('Removed', peer.label)
                leave()
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const openDevice = (deviceId: string) =>
    send({ type: 'OPEN_DEVICE', peerDeviceId: deviceId })

  return (
    <div className="device-backup" data-aeon-scope="device-backup" data-aeon-state="devices">
      <header className="device-backup-head">
        <h3>Link devices</h3>
        <p>Scan their code or show yours, then pick a backup direction.</p>
      </header>

      {error ? (
        <StatusBanner.Root tone="danger" status="add-failed">
          <StatusBanner.Copy>
            <StatusBanner.Body>{error}</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      <div className="actions device-backup-link">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            playWalletSound('soft')
            send({ type: 'SCAN' })
          }}
        >
          Scan to link
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            playWalletSound('soft')
            send({ type: 'TOGGLE_MY_CODE' })
          }}
        >
          {showMyCode ? 'Hide my code' : 'Show my code'}
        </button>
      </div>

      {showMyCode ? (
        <div className="device-backup-qr">
          <p>Scan this on the other device</p>
          {qrUrl ? (
            <DeferredImage
              src={qrUrl}
              alt="This device’s code"
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
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!pairText}
              onClick={() => void copyText(pairText, { label: 'device code' })}
            >
              Copy code
            </button>
          </div>
        </div>
      ) : null}

      {peers.length === 0 ? (
        <EmptyState
          icon={<ScanQrIcon size={22} />}
          title="No linked devices yet"
          body="Scan the other device’s code, or show yours for them to scan."
        />
      ) : (
        <div className="device-backup-sections">
          <DeviceBackupSection
            title={backedUpToTitle(backupGroups.elsewhere.length)}
            description="Each one can restore this wallet if you lose this device."
            empty="Nothing holds a copy of this wallet yet."
            headingSaysDirection
            peers={backupGroups.elsewhere}
            localIdentityKey={localIk}
            onOpen={openDevice}
          />
          <DeviceBackupSection
            title={storingTitle(backupGroups.here.length)}
            description="You can restore each of these wallets from here."
            empty="No other wallet keeps its copy here."
            headingSaysDirection
            peers={backupGroups.here}
            localIdentityKey={localIk}
            onOpen={openDevice}
          />
          {backupGroups.setup.length > 0 ? (
            <DeviceBackupSection
              title="Waiting on a choice"
              description="Open a device to pick which wallet gets backed up."
              peers={backupGroups.setup}
              localIdentityKey={localIk}
              onOpen={openDevice}
            />
          ) : null}
          {backupGroups.sameWallet.length > 0 ? (
            <DeviceBackupSection
              title="Already this wallet"
              description="Same keys on both devices, so no copy is needed."
              peers={backupGroups.sameWallet}
              localIdentityKey={localIk}
              onOpen={openDevice}
            />
          ) : null}
          {backupGroups.attention.length > 0 ? (
            <DeviceBackupSection
              title="Needs attention"
              description="A copy is missing, or both sides hold one. Open the device to fix it."
              peers={backupGroups.attention}
              localIdentityKey={localIk}
              onOpen={openDevice}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

function DeviceBackupSection({
  title,
  description,
  empty,
  /** True when the heading already says the direction — rows show platform. */
  headingSaysDirection = false,
  peers,
  localIdentityKey,
  onOpen,
}: {
  title: string
  description: string
  empty?: string
  headingSaysDirection?: boolean
  peers: DeviceWallet[]
  localIdentityKey: string
  onOpen: (deviceId: string) => void
}) {
  return (
    <section className="device-backup-section">
      <header className="device-backup-section-head">
        <h3>{title}</h3>
        {/* An empty section is explained by its one line below; two lines of
            prose for nothing is the noise this screen had. */}
        {peers.length > 0 ? <p>{description}</p> : null}
      </header>
      {peers.length > 0 ? (
        <ul className="device-backup-list">
          {peers.map((peer) => {
            const role = getDeviceBackupRoleStatus(peer.deviceId)
            const same = localIdentityKey
              ? isSameIdentityPeer(peer, localIdentityKey)
              : false
            return (
              <li key={peer.deviceId}>
                <ListRow.Root
                  className="device-backup-row"
                  data-aeon-state={roleTone(role)}
                  onClick={() => {
                    playWalletSound('soft')
                    onOpen(peer.deviceId)
                  }}
                >
                  <ListRow.Label>{peer.label}</ListRow.Label>
                  <ListRow.Description>
                    {headingSaysDirection
                      ? platformLabel(peer)
                      : same
                        ? 'Same wallet'
                        : directionLabel(peer, role, false)}
                  </ListRow.Description>
                </ListRow.Root>
              </li>
            )
          })}
        </ul>
      ) : empty ? (
        <p className="device-backup-section-empty">{empty}</p>
      ) : null}
    </section>
  )
}
