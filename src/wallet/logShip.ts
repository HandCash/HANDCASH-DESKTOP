/**
 * Ships the log tail to a support endpoint.
 *
 * Works on Mobile as well as Desktop: the Electron path uploads the on-disk
 * electron-log file, which does not exist in a WebView, so the upload is done
 * from the renderer over `fetch` with whatever the ring buffer holds.
 *
 * Upload is manual only: nothing here runs unless the user presses Send logs.
 */
import { errorText } from './errorText'
import {
  formatAppLogs,
  redactAppLogMessage,
  redactAppLogSecrets,
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
  if (typeof window === 'undefined') return 'node'
  const declared = window.handcash?.platform
  if (typeof declared === 'string' && declared) return declared
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
    ? 'android'
    : 'web'
}

/**
 * Lines of the shell's log the renderer ring does not already hold. The Mobile
 * shell answers `readLogs` with this same ring, which shipped every line twice
 * and doubled every freeze triage counted.
 */
export function shellOnlyLines(shellText: string, rendererText: string): string {
  const held = new Set(rendererText.split('\n').map((line) => line.trim()).filter(Boolean))
  return shellText
    .split('\n')
    .filter((line) => !held.has(line.trim()))
    .join('\n')
    .trim()
}

/**
 * Prefer the renderer ring (wallet / collectables / BRC paths). Electron main
 * logs alone drown those lines in bridge HTTP noise and made Desktop support
 * uploads useless for NFT verify bugs.
 */
async function platformTail(): Promise<string> {
  const renderer = formatAppLogs().trim()
  let main = ''
  try {
    const result = await window.handcash?.readLogs?.({ maxBytes: 96_000 })
    if (result?.ok && result.text.trim()) main = shellOnlyLines(result.text, renderer)
  } catch {
    // Renderer-only is fine on Mobile / when IPC is unavailable.
  }
  // Mobile's `readLogs` returns this same ring; shipping it again doubled every
  // freeze and every count triage made from an Android upload.
  if (main && renderer) {
    const seen = new Set(renderer.split('\n'))
    main = main
      .split('\n')
      .filter((line) => !seen.has(line))
      .join('\n')
      .trim()
  }
  // The ring was scrubbed line by line as it was written; scrubbing it again
  // would re-key its pseudonyms. Shell lines may predate the scrubber.
  main = scrubLines(main)
  if (renderer && main) {
    return `${renderer}\n\n—— electron main (tail) ——\n${main}`
  }
  return renderer || main
}

function scrubLines(text: string): string {
  return text.split('\n').map(redactAppLogMessage).join('\n')
}

function previousBlock(previous: AppLogEntry[]): string {
  if (previous.length === 0) return ''
  return `—— previous session (ended without a clean exit) ——\n${scrubLines(formatAppLogs(previous))}\n\n`
}

function sessionHeader(reason: string, lineCount: number): string {
  const ua =
    typeof navigator !== 'undefined'
      ? navigator.userAgent.replace(/\s+/g, ' ').slice(0, 140)
      : 'unknown'
  return [
    '# HandCash diagnostic log',
    `# version ${APP_VERSION} · platform ${platformTag()}`,
    `# reason ${reason} · lines ${lineCount}`,
    `# uploaded ${new Date().toISOString()}`,
    `# userAgent ${ua}`,
    '# privacy identifiers are per-session pseudonyms; peers, addresses and amounts removed',
    '',
  ].join('\n')
}

async function post(url: string, body: string, reason: string): Promise<LogShipResult> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { ok: false, error: 'Invalid upload URL' }
  }
  const bucketPath = target.pathname.match(/^(\/v1\/logs\/[^/]+)/)
  if (bucketPath) target.pathname = bucketPath[1]!
  if (target.protocol !== 'https:' || target.username || target.password) {
    return { ok: false, error: 'Upload URL must use HTTPS without embedded credentials' }
  }

  const redactedBody = redactAppLogSecrets(body)
  try {
    const res = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-HandCash-Log': reason,
        'X-HandCash-Version': APP_VERSION,
        'X-HandCash-Platform': platformTag(),
      },
      // Recheck restored and shell logs too, not just newly captured entries.
      body: redactedBody,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return {
        ok: false,
        error: `Upload failed (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`,
      }
    }
    return { ok: true, bytes: new TextEncoder().encode(redactedBody).byteLength }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

async function buildUploadBody(reason: string): Promise<string> {
  const previous = getPreviousSessionLogs()
  const tail = await platformTail()
  const lineCount =
    previous.length + (tail ? tail.split('\n').filter((line) => line.trim()).length : 0)
  return `${sessionHeader(reason, lineCount)}${previousBlock(previous)}${tail}`
}

/** Manual send from Settings. Includes the previous session when there is one. */
export async function shipAppLogs(url = getLogUploadUrl()): Promise<LogShipResult> {
  if (!url) return { ok: false, error: 'Set an upload URL first' }
  return post(url, await buildUploadBody('manual'), 'manual')
}

// There is no automatic upload: no boot, interval, hidden, failure or crash-recovery
// send. Logs leave the device only through `shipAppLogs`, from the user's action.
