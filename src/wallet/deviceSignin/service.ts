/**
 * Runs on every unlocked device: reports presence, polls the wallet's sign-in
 * requests, alerts once per new request and publishes Activity rows.
 */
import { localDeviceLabel } from '../deviceTransfer'
import { getOrCreateDeviceId } from '../deviceWallets'
import {
  listSigninRequests,
  reportSigninPresence,
  type SigninRequest,
} from './api'
import {
  approveSigninRequest,
  claimedHere,
  claimSigninRequest,
  refuseSigninRequest,
  signinApprovalCode,
  walletSigninKeyHex,
} from './approver'
import { signinAlertText, signinRowView, type SigninRowView } from './view'

export const SIGNIN_POLL_MS = 5_000
/** A wallet with no sign-in email checks rarely; registering on any device wakes it. */
export const SIGNIN_IDLE_POLL_MS = 60_000
export const SIGNIN_PRESENCE_MS = 5 * 60_000

/** A relay that failed (down, or not deployed yet) is retried at the idle pace, not every 5 s. */
export function nextSigninPollMs(registered: boolean | null, lastPollFailed: boolean): number {
  return registered === false || lastPollFailed ? SIGNIN_IDLE_POLL_MS : SIGNIN_POLL_MS
}

export type SigninSnapshot = {
  registered: boolean | null
  rows: SigninRowView[]
}

type Listener = (snapshot: SigninSnapshot) => void

const listeners = new Set<Listener>()
const alerted = new Set<string>()
let snapshot: SigninSnapshot = { registered: null, rows: [] }
let requests: SigninRequest[] = []
let keyHex: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let lastPollFailed = false
let lastPresenceAt = 0
let generation = 0

function publish(next: SigninSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener(next)
}

function rowsOf(list: SigninRequest[]): SigninRowView[] {
  const deviceId = getOrCreateDeviceId()
  return list.map((request) => {
    let code: string | null = null
    try {
      code = signinApprovalCode(request, deviceId)
    } catch {
      code = null
    }
    return signinRowView(request, { deviceId, claimed: claimedHere(request, deviceId), code })
  })
}

function alert(request: SigninRequest): void {
  if (alerted.has(request.binding)) return
  alerted.add(request.binding)
  if (typeof Notification === 'undefined') return
  const { title, body } = signinAlertText(request)
  try {
    const note = new Notification(title, { body, tag: `signin:${request.binding}` })
    note.onclick = () => window.focus()
  } catch {
    // The Activity row still shows the request.
  }
}

async function tick(): Promise<void> {
  if (running || !keyHex) return
  running = true
  const key = keyHex
  const round = generation
  try {
    const result = await listSigninRequests(key)
    // Locked or switched wallet while the read was out: its requests are not this wallet's.
    if (round !== generation) return
    requests = result.requests
    if (result.registered && Date.now() - lastPresenceAt >= SIGNIN_PRESENCE_MS) {
      await reportSigninPresence(key, getOrCreateDeviceId(), localDeviceLabel(), 'active')
      if (round !== generation) return
      lastPresenceAt = Date.now()
    }
    for (const request of requests) if (request.state === 'open') alert(request)
    publish({ registered: result.registered, rows: rowsOf(requests) })
    lastPollFailed = false
  } catch (error) {
    if (round !== generation) return
    lastPollFailed = true
    console.warn('[signin] poll deferred', error instanceof Error ? error.message : String(error))
  } finally {
    running = false
    schedule()
  }
}

function schedule(): void {
  if (!keyHex) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void tick(), nextSigninPollMs(snapshot.registered, lastPollFailed))
}

export function startDeviceSigninService(): void {
  if (keyHex) return
  try {
    keyHex = walletSigninKeyHex()
  } catch {
    return
  }
  void tick()
}

export function stopDeviceSigninService(signedOut = false): void {
  const key = keyHex
  const registered = snapshot.registered
  keyHex = null
  generation += 1
  if (timer) clearTimeout(timer)
  timer = null
  lastPresenceAt = 0
  lastPollFailed = false
  requests = []
  publish({ registered: null, rows: [] })
  if (signedOut && key && registered) {
    void reportSigninPresence(key, getOrCreateDeviceId(), localDeviceLabel(), 'signedOut').catch(() => undefined)
  }
}

export function refreshDeviceSignin(): void {
  lastPresenceAt = 0
  void tick()
}

export function subscribeDeviceSignin(listener: Listener): () => void {
  listeners.add(listener)
  listener(snapshot)
  return () => listeners.delete(listener)
}

function requestFor(binding: string): SigninRequest {
  const request = requests.find((entry) => entry.binding === binding)
  if (!request) throw new Error('This sign-in request is gone')
  return request
}

/** Opening a request's detail claims it for this device, so the codes can be compared here. */
export async function openSigninDetail(binding: string): Promise<void> {
  const request = requests.find((entry) => entry.binding === binding)
  if (!request || request.state !== 'open') return
  await claimSigninRequest(request)
  await tick()
}

export async function approveSignin(binding: string): Promise<void> {
  await approveSigninRequest(requestFor(binding))
  await tick()
}

export async function refuseSigninFor(binding: string): Promise<void> {
  await refuseSigninRequest(requestFor(binding))
  await tick()
}
