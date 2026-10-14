import {
  challengeDeviceLogin,
  listPendingDeviceApprovals,
  sendDevicePresence,
  type PendingDeviceApproval,
} from './login'

type Listener = (request: PendingDeviceApproval | null) => void

const listeners = new Set<Listener>()
let current: PendingDeviceApproval | null = null
let timer: ReturnType<typeof setInterval> | null = null
let running = false
let lastPresenceAt = 0

function publish(next: PendingDeviceApproval | null): void {
  current = next
  for (const listener of listeners) listener(next)
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    if (Date.now() - lastPresenceAt >= 60_000) {
      await sendDevicePresence(false)
      lastPresenceAt = Date.now()
    }
    let requests = await listPendingDeviceApprovals()
    const first = requests[0] ?? null
    if (first?.state === 'open') {
      try {
        await challengeDeviceLogin(first)
      } catch {
        // Another registered device may have claimed it first.
      }
      requests = await listPendingDeviceApprovals()
    }
    publish(requests[0] ?? null)
  } catch (error) {
    console.warn(
      '[brc250] device service deferred',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    running = false
  }
}

export function startBrc250DeviceService(): void {
  if (timer) return
  void tick()
  timer = setInterval(() => void tick(), 5_000)
}

export function stopBrc250DeviceService(signedOut = false): void {
  if (timer) clearInterval(timer)
  timer = null
  lastPresenceAt = 0
  publish(null)
  if (signedOut) void sendDevicePresence(true).catch(() => undefined)
}

export function subscribeBrc250Approval(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}

export function refreshBrc250Approvals(): void {
  void tick()
}
