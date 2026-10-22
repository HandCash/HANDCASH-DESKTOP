/**
 * The app's one call engine, bound to the active wallet: direct sessions for
 * signalling, the browser's WebRTC and microphone for media, friends and
 * blocked senders for who may ring, Activity for the outcome.
 */

import { hasDirectSession, tryDirectDeliver } from '../directSession/session'
import { isSenderBlocked } from '../blockedSenders'
import { getFriendByIdentityKey } from '../friends'
import { getActiveWallet } from '../session'
import { recordCall } from './callHistory'
import { createCallEngine, type CallEngine } from './callEngine'
import { callIceServers, readCallSettings, writeCallSettings } from './callSettings'
import { isCallFrameBody } from './callWire'
import { startRinging, stopRinging } from './ringtone'
import { captureScreen, screenFailureText, screenShareAvailable } from './screenCapture'

/** How long a call's knock waits for a ring: a hidden window reads its box every 20 s. */
export const CALL_KNOCK_PRESENCE_MS = 24_000
const CONNECT_POLL_MS = 250
const CONNECT_WAIT_MS = 36_000

let engine: CallEngine | null = null

function mayRing(peer: string): boolean {
  return !!getFriendByIdentityKey(peer) && !isSenderBlocked(peer)
}

async function connect(peer: string): Promise<boolean> {
  if (hasDirectSession(peer)) return true
  const wallet = getActiveWallet()
  if (!wallet) return false
  const { dialPeerForCall } = await import('../messageTransport')
  await dialPeerForCall(
    { rootKeyHex: wallet.rootKeyHex, senderIdentityKey: wallet.identityKey, recipientIdentityKey: peer },
    CALL_KNOCK_PRESENCE_MS,
  )
  const deadline = Date.now() + CONNECT_WAIT_MS
  while (Date.now() < deadline) {
    if (hasDirectSession(peer)) return true
    if (getActiveWallet() !== wallet) return false
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS))
  }
  return hasDirectSession(peer)
}

export function callEngine(): CallEngine {
  engine ??= createCallEngine({
    connect,
    send: (peer, body) => tryDirectDeliver({ recipientIdentityKey: peer, body }),
    rtc: () => (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection,
    iceServers: () => callIceServers(),
    getUserMedia: (constraints) => {
      const media = globalThis.navigator?.mediaDevices
      if (!media?.getUserMedia) return Promise.reject(Object.assign(new Error('no media devices'), { name: 'NotFoundError' }))
      return media.getUserMedia(constraints)
    },
    mayRing,
    record: recordCall,
    ring: (kind) => (kind ? startRinging(kind) : stopRinging()),
    now: () => Date.now(),
    devices: () => {
      const { mic, camera } = readCallSettings()
      return { mic, camera }
    },
    rememberDevice: (kind, deviceId) => writeCallSettings({ [kind]: deviceId }),
    captureScreen: screenShareAvailable() ? captureScreen : undefined,
    screenFailureText,
  })
  return engine
}

/** A call frame from the direct session goes to the engine; anything else is chat. */
export function routeCallFrame(sender: string, body: string): boolean {
  if (!isCallFrameBody(body)) return false
  if (!isSenderBlocked(sender)) callEngine().ingest(sender, body)
  return true
}

/** Lock or account switch: no call outlives the wallet it was made on. */
export function endCalls(): void {
  engine?.endAll()
}
