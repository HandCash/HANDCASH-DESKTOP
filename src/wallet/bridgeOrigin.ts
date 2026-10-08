/**
 * Who is calling the BRC-100 bridge. Every grant (Connect, view, receive,
 * auto-pay, identity proofs, the HandCash-host allowlists) is keyed by host, so
 * the host must be one the caller cannot borrow from someone else:
 *
 * - A browser's `Origin` wins over the self-declared `originator`; a page
 *   cannot forge it.
 * - `Origin: null` (sandboxed iframes, file pages) names no one. Folding it
 *   into one shared identity would let any site's sandboxed frame inherit the
 *   grants of every other.
 * - A plaintext page may claim a public host only if whoever controls the
 *   network path is allowed to be that host — never. Loopback and private
 *   network addresses stay open for local development.
 *
 * On the loopback socket a local process can still send any header it likes;
 * the bridge cannot tell it from a browser. See {@link BridgeChannel}.
 */
export type BridgeOriginRefusal =
  | 'opaque-origin'
  | 'insecure-origin'
  | 'unsupported-scheme'
  | 'no-originator'

export type BridgeCaller =
  | { kind: 'app'; host: string }
  | { kind: 'refuse'; reason: BridgeOriginRefusal }

const EXTENSION_SCHEMES = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:'])

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/

function plaintextHostAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (host.endsWith('.local')) return true
  const ipv4 = IPV4_LITERAL.exec(host)
  if (!ipv4) return false
  const a = Number(ipv4[1])
  const b = Number(ipv4[2])
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

function callerFromOrigin(rawOrigin: string): BridgeCaller {
  if (rawOrigin.trim().toLowerCase() === 'null') return { kind: 'refuse', reason: 'opaque-origin' }
  let url: URL
  try {
    url = new URL(rawOrigin)
  } catch {
    return { kind: 'refuse', reason: 'opaque-origin' }
  }
  if (!url.host) return { kind: 'refuse', reason: 'opaque-origin' }
  if (url.protocol === 'https:') return { kind: 'app', host: url.host }
  if (url.protocol === 'http:') {
    return plaintextHostAllowed(url.hostname)
      ? { kind: 'app', host: url.host }
      : { kind: 'refuse', reason: 'insecure-origin' }
  }
  if (EXTENSION_SCHEMES.has(url.protocol)) return { kind: 'app', host: url.host }
  return { kind: 'refuse', reason: 'unsupported-scheme' }
}

function callerFromOriginator(rawOriginator: string): BridgeCaller {
  try {
    const candidate = rawOriginator.includes('://') ? rawOriginator : `http://${rawOriginator}`
    const host = new URL(candidate).host
    return host ? { kind: 'app', host } : { kind: 'refuse', reason: 'no-originator' }
  } catch {
    return { kind: 'refuse', reason: 'no-originator' }
  }
}

/** Headers arrive lowercased from both the Electron and the Android bridge. */
export function resolveBridgeCaller(headers: Record<string, string | undefined>): BridgeCaller {
  const rawOrigin = headers.origin?.trim()
  if (rawOrigin) return callerFromOrigin(rawOrigin)
  const rawOriginator = headers.originator?.trim()
  if (rawOriginator) return callerFromOriginator(rawOriginator)
  return { kind: 'refuse', reason: 'no-originator' }
}

/**
 * `in-app`: Mobile app tabs post over a WebView message channel, and the
 * WebView, not the page, names the frame's origin. Anything else arrived on
 * the loopback socket, where any app on the device can claim any origin.
 */
export type BridgeChannel = 'socket' | 'in-app'

/** A grant made where the origin was vouched for is honored only there. */
export function channelMayUseGrant(
  channel: BridgeChannel,
  grantedVia: BridgeChannel | undefined,
): boolean {
  return grantedVia !== 'in-app' || channel === 'in-app'
}

export function bridgeCallerHost(caller: BridgeCaller): string | undefined {
  return caller.kind === 'app' ? caller.host : undefined
}

export function bridgeOriginRefusalDescription(reason: BridgeOriginRefusal): string {
  switch (reason) {
    case 'opaque-origin':
      return 'Sandboxed and file pages have no origin HandCash can grant. Call the wallet from an https page.'
    case 'insecure-origin':
      return 'Plain-http pages cannot use HandCash. Serve the app over https.'
    case 'unsupported-scheme':
      return 'HandCash only grants https pages and browser extensions. Native apps send an Originator header.'
    case 'no-originator':
      return 'Send an Origin or Originator header naming your app.'
  }
}
