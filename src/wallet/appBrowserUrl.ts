/**
 * What the wallet will open in its in-app browser.
 *
 * A page opened here can reach the local BRC-100 bridge, so the address is a
 * trust decision, not a convenience. Only real web origins are allowed —
 * `javascript:`, `file:`, `data:`, and `content:` are refused by name so a
 * pasted string can never execute in the wallet's own context or read the
 * device. Plaintext http is allowed on loopback only, for local development.
 */
export type AppBrowserTarget =
  | { kind: 'open'; url: string; host: string }
  | {
      kind: 'refuse'
      reason: 'empty' | 'unparsable' | 'scheme-not-allowed' | 'insecure-host'
      message: string
    }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function decideAppBrowserTarget(raw: string): AppBrowserTarget {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { kind: 'refuse', reason: 'empty', message: 'Enter a web address' }
  }
  // A bare host is the common case when typing on a phone.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { kind: 'refuse', reason: 'unparsable', message: 'That is not a web address' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      kind: 'refuse',
      reason: 'scheme-not-allowed',
      message: `The wallet browser only opens https pages, not ${parsed.protocol}`,
    }
  }
  if (!parsed.hostname) {
    return { kind: 'refuse', reason: 'unparsable', message: 'That is not a web address' }
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return {
      kind: 'refuse',
      reason: 'insecure-host',
      message: 'Plaintext http is only allowed for a local development server',
    }
  }
  return { kind: 'open', url: parsed.toString(), host: parsed.host }
}
