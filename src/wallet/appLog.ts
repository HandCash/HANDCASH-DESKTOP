/**
 * In-app log ring buffer (Mobile + Desktop renderer).
 * Desktop also tails electron-log via IPC when available.
 *
 * A crashed WebView takes the buffer with it, so the tail is mirrored to durable
 * storage and reloaded on the next start as the previous session — that is the
 * only record of what the app was doing when it died.
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { APP_VERSION } from '../version'

export type AppLogLevel = 'info' | 'warn' | 'error'

export type AppLogEntry = {
  at: number
  level: AppLogLevel
  message: string
}

const MAX = 500
/** Mirrored tail. Smaller than the ring so a flush stays cheap. */
const PERSIST_MAX = 200
const PERSIST_INTERVAL_MS = 4_000
const CURRENT_KEY = 'handcash.applog.current.v1'
const PREVIOUS_KEY = 'handcash.applog.previous.v1'

const entries: AppLogEntry[] = []
const listeners = new Set<(all: AppLogEntry[]) => void>()
let installed = false
let previousSession: AppLogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function emit() {
  const snapshot = entries.slice()
  for (const l of listeners) l(snapshot)
}

function readStored(key: string): AppLogEntry[] {
  try {
    const raw = durableGetItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is AppLogEntry =>
        !!e &&
        typeof (e as AppLogEntry).at === 'number' &&
        typeof (e as AppLogEntry).message === 'string',
    )
  } catch {
    return []
  }
}

function flushNow(): void {
  flushTimer = null
  try {
    durableSetItem(CURRENT_KEY, JSON.stringify(entries.slice(-PERSIST_MAX)))
  } catch {
    // Diagnostics must never break the app.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushNow, PERSIST_INTERVAL_MS)
}

export function appendAppLog(level: AppLogLevel, message: string): void {
  const line = String(message ?? '').trim()
  if (!line) return
  entries.push({ at: Date.now(), level, message: line.slice(0, 4000) })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
  // An error may be the last thing that happens — persist it immediately.
  if (level === 'error') flushNow()
  else scheduleFlush()
  emit()
}

/** Lines from the run before this one. Empty after a clean first install. */
export function getPreviousSessionLogs(): AppLogEntry[] {
  return previousSession.slice()
}

export function clearPreviousSessionLogs(): void {
  previousSession = []
  durableRemoveItem(PREVIOUS_KEY)
}

export function getAppLogs(): AppLogEntry[] {
  return entries.slice()
}

export function clearAppLogs(): void {
  entries.length = 0
  flushNow()
  emit()
}

export function subscribeAppLogs(listener: (all: AppLogEntry[]) => void): () => void {
  listeners.add(listener)
  listener(entries.slice())
  return () => {
    listeners.delete(listener)
  }
}

export function formatAppLogs(list = getAppLogs()): string {
  return list
    .map((e) => {
      const t = new Date(e.at).toISOString()
      return `${t} [${e.level}] ${e.message}`
    })
    .join('\n')
}

type HeapStats = { used: number; limit: number }

function readHeap(): HeapStats | null {
  const mem = (performance as unknown as {
    memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number }
  }).memory
  if (!mem?.usedJSHeapSize || !mem.jsHeapSizeLimit) return null
  return { used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)}MB`
}

function describeRuntime(): string {
  const parts: string[] = []
  const heap = readHeap()
  if (heap) parts.push(`heap ${mb(heap.used)}/${mb(heap.limit)}`)
  const nav = navigator as unknown as { deviceMemory?: number }
  if (nav.deviceMemory) parts.push(`device ${nav.deviceMemory}GB`)
  parts.push(/android/i.test(navigator.userAgent) ? 'android' : 'desktop')
  return parts.join(' · ')
}

/**
 * An OOM kill leaves no error — the process is simply gone. Recording heap
 * pressure gives the previous-session log something to point at.
 */
const HEAP_SAMPLE_MS = 20_000
const HEAP_WARN_RATIO = 0.7
let heapTimer: ReturnType<typeof setInterval> | null = null
let heapWarnedAt = 0

function startHeapWatch(): void {
  if (heapTimer || !readHeap()) return
  heapTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    const heap = readHeap()
    if (!heap) return
    const ratio = heap.used / heap.limit
    if (ratio < HEAP_WARN_RATIO) return
    const now = Date.now()
    if (now - heapWarnedAt < 60_000) return
    heapWarnedAt = now
    appendAppLog(
      'warn',
      `[memory] heap ${mb(heap.used)} of ${mb(heap.limit)} (${Math.round(ratio * 100)}%)`,
    )
  }, HEAP_SAMPLE_MS)
}

/** Capture console + optional window errors into the ring buffer (once). */
export function installAppLogCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const wrap =
    (level: AppLogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        const msg = args
          .map((a) => {
            if (typeof a === 'string') return a
            if (a instanceof Error) return a.stack || a.message
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })
          .join(' ')
        appendAppLog(level, msg)
      } catch {
        // ignore
      }
      original(...args)
    }

  console.info = wrap('info', console.info.bind(console))
  console.log = wrap('info', console.log.bind(console))
  console.warn = wrap('warn', console.warn.bind(console))
  console.error = wrap('error', console.error.bind(console))

  window.addEventListener('error', (ev) => {
    appendAppLog('error', ev.error?.stack || ev.message || 'window error')
  })
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason
    appendAppLog(
      'error',
      reason instanceof Error ? reason.stack || reason.message : `unhandledrejection ${String(reason)}`,
    )
  })

  // Last chance to persist before the OS reclaims the WebView.
  window.addEventListener('pagehide', flushNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow()
  })

  // Whatever this run writes becomes the previous session for the next one.
  previousSession = readStored(CURRENT_KEY)
  if (previousSession.length > 0) {
    try {
      durableSetItem(PREVIOUS_KEY, JSON.stringify(previousSession))
    } catch {
      // Best effort.
    }
  } else {
    previousSession = readStored(PREVIOUS_KEY)
  }
  durableRemoveItem(CURRENT_KEY)

  appendAppLog('info', `App log capture started — v${APP_VERSION} ${describeRuntime()}`)
  if (previousSession.length > 0) {
    const endedAt = previousSession[previousSession.length - 1]?.at
    appendAppLog(
      'info',
      `Previous session recovered: ${previousSession.length} line(s), last at ${
        endedAt ? new Date(endedAt).toISOString() : 'unknown'
      }`,
    )
  }
  startHeapWatch()
}
