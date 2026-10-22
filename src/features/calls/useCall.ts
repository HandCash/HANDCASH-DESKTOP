import { useEffect, useState, useSyncExternalStore } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { getFriendByIdentityKey } from '../../wallet/friends'
import { callEngine } from '../../wallet/calls/callService'
import type { CallSnapshot } from '../../wallet/calls/callEngine'

export type CallView = {
  snapshot: CallSnapshot
  /** `data-aeon-state` for the call chart. */
  state: string
  peerLabel: string
  local: MediaStream | null
  remote: MediaStream | null
}

export function callPeerLabel(identityKey: string | null): string {
  if (!identityKey) return ''
  return getFriendByIdentityKey(identityKey)?.label ?? `${identityKey.slice(0, 8)}…`
}

function subscribe(listener: () => void): () => void {
  return callEngine().subscribe(listener)
}

function version(): number {
  return callEngine().version()
}

/** The call chart and its media, for the dock and Activity. */
export function useCall(): CallView {
  useSyncExternalStore(subscribe, version, version)
  const engine = callEngine()
  const snapshot = engine.getSnapshot()
  return {
    snapshot,
    state: stateToAttr(snapshot.value),
    peerLabel: callPeerLabel(snapshot.context.peer),
    local: engine.localStream(),
    remote: engine.remoteStream(),
  }
}

/** Milliseconds on the call so far, ticking each second while it is connected. */
export function useCallElapsed(connectedAt: number | null, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (connectedAt == null || endedAt != null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [connectedAt, endedAt])
  if (connectedAt == null) return 0
  return Math.max(0, (endedAt ?? now) - connectedAt)
}
