/**
 * Which browser origins may call the LAN device-peer port.
 *
 * Only HandCash's own windows: the Desktop UI (keep in sync with UI_ORIGIN in
 * uiServer.ts), its file:// fallback and Mobile's WebView. A request with no
 * Origin header comes from a native client, not a web page. A sandboxed frame
 * on any site can also send `null`, so this is not the credential: wallet
 * routes still need a device-peer proof.
 */
const WALLET_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost:5173',
  'null',
  'https://localhost',
  'capacitor://localhost',
])

export function devicePeerOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined || WALLET_ORIGINS.has(origin)
}

export function devicePeerCorsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !WALLET_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  }
}
