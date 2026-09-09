import {
  isTrustedAppUrl,
  rewriteForcedHttpsUiUrl,
  type AppUrlPolicy,
} from './appUrlPolicy.js'
import type { BridgeWindowRefusal } from './bridgeWindow.js'

/**
 * Chromium HTTPS-First features that rewrite http://localhost:5173 → https://
 * and blank the wallet UI (Vite / packaged UI are HTTP-only). Keep this list
 * in sync with `app.commandLine.appendSwitch('disable-features', …)` in main.
 */
export const DISABLE_HTTPS_FIRST_FEATURES = [
  'HttpsFirstMode',
  'HttpsFirstModeV2',
  'HttpsFirstBalancedMode',
  'HttpsFirstModeInterstitial',
  'HttpsUpgrades',
  'AutomaticHttpsUpgrades',
] as const

export type WalletUiNavigationDecision =
  | { action: 'allow' }
  /** Cancel an HTTPS-First redirect without tearing down the live renderer. */
  | { action: 'block-https-upgrade'; url: string }
  | { action: 'open-external'; url: string }
  | { action: 'deny' }

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * Main-window navigation policy for BRC-100 connect health.
 *
 * The wallet UI is HTTP-only (`http://localhost:5173`). Never `loadURL` to
 * "fix" an https upgrade — that tears down the renderer and leaves every
 * app connect as `renderer-not-ready`. Cancel the upgrade; disable HTTPS-First
 * so Chromium stops attempting it.
 */
export function decideWalletUiNavigation(
  url: string,
  policy: AppUrlPolicy,
  _opts?: { eventKind?: 'navigate' | 'redirect' },
): WalletUiNavigationDecision {
  const rewritten = rewriteForcedHttpsUiUrl(url, policy)
  if (rewritten) {
    return { action: 'block-https-upgrade', url: rewritten }
  }
  if (isTrustedAppUrl(url, policy)) return { action: 'allow' }
  if (isSafeExternalUrl(url)) return { action: 'open-external', url }
  return { action: 'deny' }
}

/** Bridge refusal → HTTP 503 body code clients see on connect. */
export type BridgeConnectRefusal = BridgeWindowRefusal

const REFUSAL_DESCRIPTION: Record<BridgeConnectRefusal, string> = {
  'app-quitting': 'wallet is quitting',
  'window-unavailable': 'wallet window could not be opened',
  'renderer-not-ready': 'wallet window is still loading',
}

export function bridgeConnectUnavailableMessage(reason: BridgeConnectRefusal): string {
  return `WALLET_BRIDGE_UNAVAILABLE: ${REFUSAL_DESCRIPTION[reason]} (${reason})`
}

export function bridgeConnectUnavailableCode(message: string): string | null {
  return message.includes('WALLET_BRIDGE_UNAVAILABLE') ? 'WALLET_BRIDGE_UNAVAILABLE' : null
}

/** Headers browsers need for Private Network Access to localhost :2121/:3321. */
export function bridgeCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
  }
}
