import { looksLikePeerPayUri, tryParsePeerPayUri } from './peerPayUri'
import { openSendFlow } from './navStore'

/**
 * Links the OS may hand this wallet.
 *
 * A deep link arrives from outside — a message, a QR, another app — so it is
 * untrusted input that lands on a funded wallet. Only URIs this wallet already
 * understands get a destination; everything else is refused by name rather than
 * guessed at, and no deep link ever moves value on its own. A PeerPay link is a
 * *request* to pay, so it opens Send prefilled and waits for the user.
 */
export type WalletDeepLink =
  | {
      kind: 'send-request'
      uri: string
      identityKey: string
      /** Requested amount, when the link named one. */
      sats: number | null
    }
  | {
      kind: 'refuse'
      reason: 'empty' | 'unknown-scheme' | 'malformed-peerpay'
      message: string
    }

export function decideWalletDeepLink(raw: string): WalletDeepLink {
  const uri = raw.trim()
  if (!uri) {
    return { kind: 'refuse', reason: 'empty', message: 'Deep link was empty' }
  }
  if (!looksLikePeerPayUri(uri)) {
    return {
      kind: 'refuse',
      reason: 'unknown-scheme',
      message: `This wallet does not open links of this kind: ${uri.slice(0, 24)}`,
    }
  }
  const parsed = tryParsePeerPayUri(uri)
  if (!parsed) {
    return {
      kind: 'refuse',
      reason: 'malformed-peerpay',
      message: 'PeerPay link is not a valid identity key request',
    }
  }
  const canonical =
    parsed.sats != null
      ? `peerpay:${parsed.identityKey}?sats=${parsed.sats}`
      : `peerpay:${parsed.identityKey}`
  return {
    kind: 'send-request',
    uri: canonical,
    identityKey: parsed.identityKey,
    sats: parsed.sats,
  }
}

/** Decide, then navigate. Returns the decision so shells can log or report it. */
export function routeWalletDeepLink(raw: string): WalletDeepLink {
  const decision = decideWalletDeepLink(raw)
  if (decision.kind === 'refuse') {
    console.warn(`[deep-link] refused (${decision.reason}) ${decision.message}`)
    return decision
  }
  console.info(`[deep-link] send request for ${decision.identityKey.slice(0, 10)}…`)
  openSendFlow(decision.uri)
  return decision
}
