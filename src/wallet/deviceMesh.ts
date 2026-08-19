/**
 * Poll paired same-identity peers: friends merge + local-item snapshots.
 * Cross-identity linked devices skip LAN mesh (separate pots; no shared spend).
 */
import { mergeFriends } from './friends'
import {
  enrollLocalDevice,
  listDeviceWallets,
  patchDeviceWallet,
  type DeviceWallet,
} from './deviceWallets'
import {
  fetchDevicePeerSnapshot,
  probeDevicePeer,
  type DevicePeerSnapshot,
} from './devicePeer'
import { getActiveWallet } from './session'

const POLL_MS = 8_000

type SnapshotListener = (cache: Map<string, DevicePeerSnapshot>) => void

const snapshotCache = new Map<string, DevicePeerSnapshot>()
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

async function refreshPeer(peer: DeviceWallet, identityKey: string): Promise<void> {
  if (!peer.peerBaseUrl) {
    patchDeviceWallet(peer.deviceId, { online: false })
    return
  }
  const health = await probeDevicePeer(peer.peerBaseUrl)
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
    const snap = await fetchDevicePeerSnapshot(peer.peerBaseUrl, identityKey)
    snapshotCache.set(peer.deviceId, snap)
    notifySnapshots()
    if (Array.isArray(snap.friends) && snap.friends.length > 0) {
      mergeFriends(snap.friends)
    }
  } catch {
    // Keep last good snapshot; still mark online from health.
  }
}

export async function pollDeviceMeshOnce(): Promise<void> {
  if (polling) return
  const active = getActiveWallet()
  if (!active) return
  polling = true
  try {
    await enrollLocalFromBridge(active.identityKey)
    const peers = listDeviceWallets().filter(
      (w) =>
        !w.isLocal &&
        w.identityKey.toLowerCase() === active.identityKey.toLowerCase(),
    )
    await Promise.all(peers.map((p) => refreshPeer(p, active.identityKey)))
  } finally {
    polling = false
  }
}

/** Start background mesh while wallet is unlocked. */
export function startDeviceMesh(identityKey: string): () => void {
  void enrollLocalFromBridge(identityKey).then(() => pollDeviceMeshOnce())
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
  notifySnapshots()
}
