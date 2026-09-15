/**
 * Peer BSV-21 capability — warn before token sends when the recipient may not
 * settle tips into basket `bsv21` (and could sweep them as ordinary 1-sat dust).
 *
 * ## How information is stored and fetched (plain map)
 *
 * There is no on-chain "supports BSV-21" flag. Capability is optional metadata
 * hung off an **identity key**, same pattern as `messagebox`:
 *
 * 1. **Publish (their wallet / cloud)** — when a wallet claims a handle or
 *    updates identity profile, the resolve host MAY return
 *    `protocols: ["bsv21", "1sat", …]` next to `identityKey` + `messagebox`.
 * 2. **Fetch** — we already GET BRC-CLOUD
 *    `/.well-known/metanet-handles/resolve?handle=…` (or `?identityKey=…`).
 *    {@link parseWalletProtocols} reads that JSON field when present.
 * 3. **Store locally** — friends list (durable per vault account) MAY keep a
 *    copy of `protocols` beside `messagebox`, so the next send does not need
 *    another round trip.
 * 4. **Gate** — Send Fungible asks {@link assessPeerBsv21Support}. Missing or
 *    empty protocols ⇒ **unknown** ⇒ warn (still allow send). Explicit
 *    `bsv21` ⇒ supported. Bare address (no identity) ⇒ no-identity warn.
 *
 * Until hosts publish `protocols`, almost every peer is **unknown** — that is
 * intentional: warn by default; do not invent support.
 */
import { getActiveWallet } from './session'

export const BSV21_PROTOCOL_ID = 'bsv21'

export type PeerBsv21Support =
  | 'self'
  | 'supported'
  | 'unknown'
  | 'unsupported'
  | 'no-identity'

/** Normalize cloud / friend protocol tags to lowercase tokens. */
export function parseWalletProtocols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const row of raw) {
    if (typeof row !== 'string') continue
    const t = row.trim().toLowerCase()
    if (!t) continue
    // Accept common aliases from drafts / older docs.
    if (t === 'bsv-21' || t === 'brc-162' || t === 'brc162') {
      out.push(BSV21_PROTOCOL_ID)
      continue
    }
    out.push(t)
  }
  return [...new Set(out)]
}

export function protocolsIncludeBsv21(protocols: readonly string[] | null | undefined): boolean {
  if (!protocols?.length) return false
  return protocols.map((p) => p.trim().toLowerCase()).includes(BSV21_PROTOCOL_ID)
}

/**
 * Resolve support for a send target.
 *
 * `protocols` — from the latest handle resolve or friend row when known.
 * Prefer passing what the UI just fetched (resolve and/or friend.protocols).
 */
export function assessPeerBsv21Support(args: {
  recipientIdentityKey?: string | null
  protocols?: readonly string[] | null
}): PeerBsv21Support {
  const key = (args.recipientIdentityKey ?? '').trim().toLowerCase()
  if (!key) return 'no-identity'

  const self = getActiveWallet()?.identityKey?.trim().toLowerCase()
  if (self && self === key) return 'self'

  const protocols = parseWalletProtocols(args.protocols ?? [])
  if (protocols.length === 0) return 'unknown'
  return protocolsIncludeBsv21(protocols) ? 'supported' : 'unsupported'
}

/** User-facing copy for Send Fungible (warn only — never blocks). */
export function peerBsv21SupportWarning(status: PeerBsv21Support): string | null {
  switch (status) {
    case 'self':
    case 'supported':
      return null
    case 'no-identity':
      return (
        'This looks like a plain address — we cannot tell if their wallet ' +
        'supports BSV-21 tokens. They may see it as 1-sat dust and spend it by mistake.'
      )
    case 'unsupported':
      return (
        'This peer’s identity does not advertise BSV-21 support. ' +
        'Their wallet may not put the tip in Tokens and could spend it as ordinary sats.'
      )
    case 'unknown':
      return (
        'We could not verify BSV-21 support for this peer yet (no protocols on their ' +
        'identity / handle). Remittance may not file the tip into Tokens — they could ' +
        'accidentally spend it as dust.'
      )
  }
}
