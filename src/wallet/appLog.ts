/**
 * In-app log ring buffer (Mobile + Desktop renderer).
 * Desktop also tails electron-log via IPC when available.
 */

export type AppLogLevel = 'info' | 'warn' | 'error'

export type AppLogEntry = {
  at: number
  level: AppLogLevel
  message: string
}

const MAX = 500
const entries: AppLogEntry[] = []
const listeners = new Set<(all: AppLogEntry[]) => void>()
let installed = false

function emit() {
  const snapshot = entries.slice()
  for (const l of listeners) l(snapshot)
}

export function appendAppLog(level: AppLogLevel, message: string): void {
  const line = String(message ?? '').trim()
  if (!line) return
  entries.push({ at: Date.now(), level, message: line.slice(0, 4000) })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
  emit()
}

export function getAppLogs(): AppLogEntry[] {
  return entries.slice()
}

export function clearAppLogs(): void {
  entries.length = 0
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

  appendAppLog('info', 'App log capture started')
}
