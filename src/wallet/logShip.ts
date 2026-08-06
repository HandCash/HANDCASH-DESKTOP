/**
 * Ships the log tail to a support endpoint.
 *
 * Works on Mobile as well as Desktop: the Electron path uploads the on-disk
 * electron-log file, which does not exist in a WebView, so the upload is done
 * from the renderer over `fetch` with whatever the ring buffer holds.
 *
 * The crash case is the reason this exists — a previous session recovered at
 * boot is shipped automatically, because the user cannot press a button in an
 * app that already died.
 */
import {
  formatAppLogs,
  getPreviousSessionLogs,
  type AppLogEntry,
} from './appLog'
import { getLogUploadUrl } from './logUploadPrefs'
import { APP_VERSION } from '../version'

export type LogShipResult =
  | { ok: true; bytes: number; skipped?: false }
  | { ok: false; error: string }
  | { ok: true; skipped: true; reason: string }

function platformTag(): string {
  const declared = window.handcash?.platform
  if (typeof declared === 'string' && declared) return declared
  return /android/i.test(navigator.userAgent) ? 'android' : 'web'
}

async function platformTail(): Promise<string> {
  try {
    const result = await window.handcash?.readLogs?.({ maxBytes: 256_000 })
    if (result?.ok && result.text.trim()) return result.text
  } catch {
    // Fall back to the in-memory ring below.
  }
  return formatAppLogs()
}

function previousBlock(previous: AppLogEntry[]): string {
  if (previous.length === 0) return ''
  return `—— previous session (ended without a clean exit) ——\n${formatAppLogs(previous)}\n\n`
}

async function post(url: string, body: string, reason: string): Promise<LogShipResult> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { ok: false, error: 'Invalid upload URL' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: 'Upload URL must be http(s)' }
  }

  try {
    const res = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-HandCash-Log': reason,
        'X-HandCash-Version': APP_VERSION,
        'X-HandCash-Platform': platformTag(),
      },
      body,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return {
        ok: false,
        error: `Upload failed (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`,
      }
    }
    return { ok: true, bytes: body.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Manual send from Settings. Includes the previous session when there is one. */
export async function shipAppLogs(url = getLogUploadUrl()): Promise<LogShipResult> {
  if (!url) return { ok: false, error: 'Set an upload URL first' }
  const body = `${previousBlock(getPreviousSessionLogs())}${await platformTail()}`
  return post(url, body, 'manual')
}

let shippedPrevious = false

/**
 * Auto-send a recovered crash log, once per launch. Silent by design: it runs
 * at boot, and a failure here must never interrupt unlocking a wallet.
 */
export async function shipPreviousSessionLogs(): Promise<LogShipResult> {
  if (shippedPrevious) return { ok: true, skipped: true, reason: 'already shipped' }
  const url = getLogUploadUrl()
  if (!url) return { ok: true, skipped: true, reason: 'no upload URL configured' }
  const previous = getPreviousSessionLogs()
  if (previous.length === 0) return { ok: true, skipped: true, reason: 'clean previous run' }

  shippedPrevious = true
  const result = await post(url, previousBlock(previous) + formatAppLogs(), 'crash-recovery')
  if (result.ok) console.info(`[logs] previous session uploaded (${previous.length} lines)`)
  else console.warn('[logs] previous session upload failed', result.error)
  return result
}
