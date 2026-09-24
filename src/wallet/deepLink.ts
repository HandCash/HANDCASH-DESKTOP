import { buildBrc29SettlementUri, looksLikeBrc29SettlementUri, tryParseBrc29SettlementUri } from './brc29Uri'
import { looksLikePeerPayUri, tryParsePeerPayUri } from './peerPayUri'
import { openSendFlow } from './navStore'

/**
 * Links the OS may hand this wallet.
 *
 * A deep link arrives from outside — a message, a QR, another app — so it is
 * untrusted input that lands on a funded wallet. Only URIs this wallet already
 * understands get a destination; everything else is refused by name rather than
 * guessed at, and no deep link ever moves value on its own.
 *
 * Both claimed schemes are vendor-neutral BRCs, and a tapped link is the same
 * input Scan and paste already accept — never a new delivery path:
 * - BRC-125 `peerpay:` is a *request* to pay, so it opens Send prefilled.
 * - BRC-29 `brc29:` is a settlement receipt for money already sent to us, so it
 *   opens Send on the claim path (`claimBrc29SettlementUri`), which internalizes
 *   by SPV and never signs a second payment.
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
      kind: 'settlement-receipt'
      uri: string
      /** Us — the payee this receipt can be internalized by. */
      identityKey: string
      txid: string
      sats: number | null
    }
  | {
      kind: 'refuse'
      reason: 'empty' | 'unknown-scheme' | 'malformed-peerpay' | 'malformed-brc29'
      message: string
    }

export function decideWalletDeepLink(raw: string): WalletDeepLink {
  const uri = raw.trim()
  if (!uri) {
    return { kind: 'refuse', reason: 'empty', message: 'Deep link was empty' }
  }
  if (looksLikeBrc29SettlementUri(uri)) {
    const receipt = tryParseBrc29SettlementUri(uri)
    if (!receipt) {
      return {
        kind: 'refuse',
        reason: 'malformed-brc29',
        message: 'BRC-29 link is not a valid settlement receipt',
      }
    }
    return {
      kind: 'settlement-receipt',
      uri: buildBrc29SettlementUri(receipt),
      identityKey: receipt.payeeIdentityKey,
      txid: receipt.txid,
      sats: receipt.sats,
    }
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
  const what = decision.kind === 'send-request' ? 'send request' : 'settlement receipt'
  console.info(`[deep-link] ${what} for ${decision.identityKey.slice(0, 10)}…`)
  openSendFlow(decision.uri)
  return decision
}
