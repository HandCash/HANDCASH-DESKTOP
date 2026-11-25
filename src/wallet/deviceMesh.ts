import { getActiveWallet } from './session'

/**
 * Poll paired same-identity peers: friends merge + local-item snapshots.
 * Recovery-only peers skip LAN mesh (different identities; no shared state).
 */
import { mergeFriends } from './friends'
import {
  enrollLocalDevice,
  listDeviceWallets,
  patchDeviceWallet,
  type DeviceWallet,
} from './deviceWallets'
import {
  fetchDevicePeerIdentities,
  fetchDevicePeerSnapshot,
  probeDevicePeer,
  type DevicePeerSnapshot,
} from './devicePeer'
import { mergeRemoteIdentityBundle, requestIdentitiesOverVaultLink, syncVaultIdentitiesBox } from './identityPeerSync'
import { openVaultLinkDevices } from './vaultLink'
import { holdingOf, isHeldHere, readVaultAccounts, rootKeyHexForAccount } from './vaultAccounts'
import { vaultIdentityKey } from './vaultMaster'


const POLL_MS = 8_000
const IDENTITY_SYNC_COOLDOWN_MS = 30_000
const lastIdentitySyncByPeer = new Map<string, number>()
const lastMissingIdentityRequestAt = new Map<string, number>()

type SnapshotListener = (cache: Map<string, DevicePeerSnapshot>) => void

const snapshotCache = new Map<string, DevicePeerSnapshot>()
/** The identity whose peers `snapshotCache` holds; another account's snapshots are never shown. */
let snapshotIdentity: string | null = null
const snapshotListeners = new Set<SnapshotListener>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false

function notifySnapshots() {
  const copy = new Map(snapshotCache)
  for (const l of snapshotListeners) l(copy)
}

export function getRemoteSnapshot(deviceId: string): DevicePeerSnapshot | null {
  return snapshotCache.get(deviceId) ?? null
}

export function subscribeRemoteSnapshots(listener: SnapshotListener): () => void {
  snapshotListeners.add(listener)
  listener(new Map(snapshotCache))
  return () => {
    snapshotListeners.delete(listener)
  }
}

export async function enrollLocalFromBridge(identityKey: string): Promise<DeviceWallet> {
  const status = await window.handcash?.getBridgeStatus?.()
  const peerBaseUrl =
    status?.devicePeerLanUrls?.[0] ??
    (status?.devicePeerPort
      ? `http://127.0.0.1:${status.devicePeerPort}`
      : null)
  const active = getActiveWallet()
  return enrollLocalDevice({
    identityKey,
    address: active?.address ?? null,
    platform: window.handcash?.platform,
    peerBaseUrl,
  })
}

async function refreshPeer(peer: DeviceWallet, identityKey: string, rootKeyHex: string): Promise<void> {
  if (!peer.peerBaseUrl) {
    patchDeviceWallet(peer.deviceId, { online: false })
    return
  }
  const health = await probeDevicePeer(peer.peerBaseUrl, rootKeyHex)
  if (!health || health.identityKey !== identityKey) {
    patchDeviceWallet(peer.deviceId, { online: false })
    return
  }
  patchDeviceWallet(peer.deviceId, {
    online: true,
    lastSeenAt: Date.now(),
    label: health.label || undefined,
  })
  try {
    const snap = await fetchDevicePeerSnapshot(peer.peerBaseUrl, identityKey, rootKeyHex)
    if (snapshotIdentity !== identityKey.toLowerCase()) return
    snapshotCache.set(peer.deviceId, snap)
    notifySnapshots()
    if (Array.isArray(snap.friends) && snap.friends.length > 0) {
      mergeFriends(snap.friends)
    }
  } catch {
    // Keep last good snapshot; still mark online from health.
  }
  const now = Date.now()
  const lastSync = lastIdentitySyncByPeer.get(peer.deviceId) ?? 0
  if (now - lastSync >= IDENTITY_SYNC_COOLDOWN_MS) {
    lastIdentitySyncByPeer.set(peer.deviceId, now)
    try {
      const active = getActiveWallet()
      if (active && active.identityKey.toLowerCase() === identityKey.toLowerCase()) {
        const bundle = await fetchDevicePeerIdentities(peer.peerBaseUrl, identityKey, rootKeyHex)
        await mergeRemoteIdentityBundle(active.chain, bundle, { allowUncheckedBapHeaders: true })
      }
    } catch {
      // Peer may be an older build without /identities; keep polling silently.
    }
  }
}

export async function pollDeviceMeshOnce(): Promise<void> {
  if (polling) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const active = getActiveWallet()
  if (!active) return
  const peers = listDeviceWallets().filter(
    (w) =>
      !w.isLocal &&
      w.identityKey.toLowerCase() === active.identityKey.toLowerCase(),
  )
  if (peers.length === 0) return
  polling = true
  try {
    await Promise.all(peers.map((p) => refreshPeer(p, active.identityKey, active.rootKeyHex)))
  } finally {
    polling = false
  }
}

/** Start background mesh while wallet is unlocked. */
export function startDeviceMesh(identityKey: string): () => void {
  if (snapshotIdentity !== identityKey.toLowerCase()) {
    snapshotCache.clear()
    snapshotIdentity = identityKey.toLowerCase()
    notifySnapshots()
  }
  void enrollLocalFromBridge(identityKey).then(() => pollDeviceMeshOnce())
  void syncIdentitiesFromConnectedPeers().catch(() => {})
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void pollDeviceMeshOnce()
  }, POLL_MS)
  return () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

export function clearRemoteSnapshots(): void {
  snapshotCache.clear()
  snapshotIdentity = null
  lastIdentitySyncByPeer.clear()
  lastMissingIdentityRequestAt.clear()
  notifySnapshots()
}

/** Pull missing identity profiles and BAP packages from connected LAN, vaultLink, and messagebox peers for all connected wallets. */
export async function syncIdentitiesFromConnectedPeers(args?: {
  identityKeys?: string[]
  bapIds?: string[]
}): Promise<{ profilesAdded: number; bapPackagesAdded: number; cardsAdded: number }> {
  const active = getActiveWallet()
  const totals = { profilesAdded: 0, bapPackagesAdded: 0, cardsAdded: 0 }
  if (!active || !active.chain) return totals

  const vaultStore = active.vaultMaster ? readVaultAccounts(vaultIdentityKey(active.vaultMaster)) : null
  const vaultAccounts = vaultStore?.accounts ?? []
  const vaultKeys = new Set<string>([active.identityKey.toLowerCase()])
  if (active.vaultMaster) vaultKeys.add(vaultIdentityKey(active.vaultMaster).toLowerCase())
  for (const acc of vaultAccounts) vaultKeys.add(acc.identityKey.toLowerCase())

  const activeAccount = vaultAccounts.find((a) => a.index === active.accountIndex)
  const activeHeldHere = activeAccount ? isHeldHere(activeAccount) : true

  // Candidate auth keys for non-custodial /identities fetches: locally held accounts + vault coordination key (account 0).
  const authCandidates: Array<{ identityKey: string; rootKeyHex: string }> = []
  const seenAuth = new Set<string>()
  const pushAuth = (ik: string, rootHex: string) => {
    const low = ik.toLowerCase()
    if (!seenAuth.has(low)) {
      seenAuth.add(low)
      authCandidates.push({ identityKey: low, rootKeyHex: rootHex })
    }
  }
  if (activeHeldHere && active.rootKeyHex) pushAuth(active.identityKey, active.rootKeyHex)
  if (active.vaultMaster) {
    for (const acc of vaultAccounts) {
      if (!isHeldHere(acc)) continue
      try {
        pushAuth(acc.identityKey, rootKeyHexForAccount(active.vaultMaster, acc.index))
      } catch {
        /* ignore */
      }
    }
    try {
      pushAuth(vaultIdentityKey(active.vaultMaster), rootKeyHexForAccount(active.vaultMaster, 0))
    } catch {
      /* ignore */
    }
  }

  const seenUrls = new Set<string>()
  const peers = listDeviceWallets().filter((w) => {
    if (w.isLocal || !w.peerBaseUrl) return false
    if (!vaultKeys.has(w.identityKey.toLowerCase())) return false
    const url = w.peerBaseUrl.trim().replace(/\/+$/, '')
    if (!url || seenUrls.has(url)) return false
    seenUrls.add(url)
    return true
  })
  if (typeof fetchDevicePeerIdentities === 'function' && authCandidates.length > 0) {
    await Promise.all(
      peers.map(async (peer) => {
        if (!peer.peerBaseUrl) return
        const peerIk = peer.identityKey.toLowerCase()
        const ordered = [
          ...authCandidates.filter((c) => c.identityKey === peerIk),
          ...authCandidates.filter((c) => c.identityKey !== peerIk),
        ]
        for (const cand of ordered) {
          try {
            const bundle = await fetchDevicePeerIdentities(
              peer.peerBaseUrl,
              peer.identityKey,
              cand.rootKeyHex,
              undefined,
              vaultKeys,
            )
            const res = await mergeRemoteIdentityBundle(active.chain, bundle, { allowUncheckedBapHeaders: true })
            totals.profilesAdded += res.profilesAdded
            totals.bapPackagesAdded += res.bapPackagesAdded
            totals.cardsAdded += res.cardsAdded
            lastIdentitySyncByPeer.set(peer.deviceId, Date.now())
            break
          } catch (err) {
            const msg = err instanceof Error ? err.message : ''
            if (!msg.includes('(401)')) break
          }
        }
      }),
    )
  }
  const holderDevices = vaultAccounts.flatMap((acc) => {
    const h = holdingOf(acc)
    return h.kind === 'elsewhere' && h.deviceId ? [h.deviceId] : []
  })
  const linkDevices = new Set<string>([
    ...peers.map((p) => p.deviceId),
    ...holderDevices,
    ...(typeof openVaultLinkDevices === 'function' ? openVaultLinkDevices() : []),
  ])
  await requestIdentitiesOverVaultLink({
    chain: active.chain,
    devices: linkDevices,
    identityKeys: args?.identityKeys,
    bapIds: args?.bapIds,
  }).catch(() => {})

  // Ask sibling vault accounts (especially those held on other devices or missing a local profile)
  // for their identity card over the peer inbox when the active account is held locally.
  if (activeHeldHere && vaultAccounts.length > 1) {
    const activeIk = active.identityKey.toLowerCase()
    try {
      const [{ accountProfile }, { requestIdentityCard }] = await Promise.all([
        import('./publicIdentities'),
        import('./identityCardShare'),
      ])
      const siblings = vaultAccounts.filter((acc) => {
        const ik = acc.identityKey.toLowerCase()
        if (ik === activeIk) return false
        return !isHeldHere(acc) || !accountProfile({ identityKey: acc.identityKey, accountIndex: acc.index, chain: active.chain })
      })
      await Promise.all(
        siblings.map((acc) =>
          requestIdentityCard({ identityKey: acc.identityKey, messagebox: null }).catch(() => false),
        ),
      )
    } catch {
      /* ignore in minimal test environments */
    }
  }

  const boxRes = await syncVaultIdentitiesBox().catch(() => ({
    profilesAdded: 0,
    bapPackagesAdded: 0,
    cardsAdded: 0,
  }))
  totals.profilesAdded += boxRes.profilesAdded
  totals.bapPackagesAdded += boxRes.bapPackagesAdded
  totals.cardsAdded += boxRes.cardsAdded
  return totals
}

/**
 * Rate-limited pull from connected LAN and vaultLink peers when an asset's
 * issuing identity key or BAP ID has no verified profile on this device.
 */
export function requestMissingIdentitiesFromConnectedPeers(args: {
  identityKeys?: string[]
  bapIds?: string[]
}): void {
  const keys = [...new Set((args.identityKeys ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))].sort()
  const bapIds = [...new Set((args.bapIds ?? []).map((b) => b.trim()).filter(Boolean))].sort()
  if (keys.length === 0 && bapIds.length === 0) return
  const sig = `${keys.join(',')}|${bapIds.join(',')}`
  const now = Date.now()
  const prev = lastMissingIdentityRequestAt.get(sig) ?? 0
  if (now - prev < IDENTITY_SYNC_COOLDOWN_MS) return
  lastMissingIdentityRequestAt.set(sig, now)
  void syncIdentitiesFromConnectedPeers({ identityKeys: keys, bapIds }).catch(() => {})
}
