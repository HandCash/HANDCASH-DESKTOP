import { useEffect, useState, useSyncExternalStore } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { getFriendByIdentityKey } from '../../wallet/friends'
import { callEngine } from '../../wallet/calls/callService'
import type { CallParticipant, CallSnapshot } from '../../wallet/calls/callEngine'
import { listCallDevices, subscribeDeviceChanges, type CallDevice } from '../../wallet/calls/mediaDevices'

export type CallView = {
  snapshot: CallSnapshot
  /** `data-aeon-state` for the call chart. */
  state: string
  peerLabel: string
  /** More than one other person on the call. */
  group: boolean
  /** Everyone else on the call, for the group grid. */
  participants: CallParticipant[]
  local: MediaStream | null
  remote: MediaStream | null
}

export function callPeerLabel(identityKey: string | null): string {
  if (!identityKey) return ''
  return getFriendByIdentityKey(identityKey)?.label ?? `${identityKey.slice(0, 8)}…`
}

/** The people on a call, by name: "Bob and Carol", "Bob, Carol and Dave", "Bob and 3 others". */
export function callMembersLabel(identityKeys: string[]): string {
  const names = identityKeys.map(callPeerLabel)
  if (names.length <= 1) return names[0] ?? ''
  if (names.length > 3) return `${names[0]} and ${names.length - 1} others`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
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
  const { members, peer } = snapshot.context
  const group = members.length > 1
  return {
    snapshot,
    state: stateToAttr(snapshot.value),
    peerLabel: group ? callMembersLabel(members) : callPeerLabel(peer),
    group,
    participants: group ? engine.participants() : [],
    local: engine.localStream(),
    remote: engine.remoteStream(),
  }
}

/**
 * Microphones and cameras, listed again when one is plugged in or out, and
 * when the call's own media opens (labels only show once a device was allowed).
 */
export function useCallDevices(active: boolean, revision: unknown): CallDevice[] {
  const [devices, setDevices] = useState<CallDevice[]>([])
  useEffect(() => {
    if (!active) return
    let live = true
    const load = () =>
      void listCallDevices().then((next) => {
        if (live) setDevices(next)
      })
    load()
    const stop = subscribeDeviceChanges(load)
    return () => {
      live = false
      stop()
    }
  }, [active, revision])
  return devices
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
