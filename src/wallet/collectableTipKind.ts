/**
 * Explicit tip / send-path vocabulary for collectables.
 *
 * Tip kind and send path are tagged unions so a covenant-locked tip cannot
 * silently fall through to soft-latch. Routing lives in `chooseSendPath`; the
 * XState parent (`collectableSendMachine`) only invokes what that returns.
 *
 * Soft-latch (tip + 2-sat latch) is the only spend path. Covenant / unknown
 * tips refuse — the UI offers abandon instead of send.
 */
import { toUnderscoreOutpoint } from './oneSatLatch'

export type TipKind =
  | { kind: 'covenantLocked'; lockingScript: string }
  | { kind: 'softP2pkh'; lockingScript: string }
  | { kind: 'unknown' }

export type SendPath =
  | { path: 'softLatch'; latchOutpoint: string | null }
  | { path: 'refuse'; reason: string }

export type ProvenTier = 'brc156' | 'brc150' | 'unproven'

export function classifyTipKind(
  lockingScript: string | undefined | null,
): TipKind {
  const hex = typeof lockingScript === 'string' ? lockingScript.trim() : ''
  if (!hex) return { kind: 'unknown' }
  if (/^76a914[0-9a-f]{40}88ac$/i.test(hex)) {
    return { kind: 'softP2pkh', lockingScript: hex }
  }
  // Long non-P2PKH scripts (legacy BRC-156 covenant tips) cannot soft-latch.
  if (hex.length >= 80) {
    return { kind: 'covenantLocked', lockingScript: hex }
  }
  return { kind: 'unknown' }
}

/** True when the locking script is a covenant / non-P2PKH stuck tip candidate. */
export function isCovenantLockedScript(
  scriptHex: string | undefined | null,
): boolean {
  return classifyTipKind(scriptHex).kind === 'covenantLocked'
}

export type ChooseSendPathArgs = {
  tipKind: TipKind
  /** Soft-latch dust outpoint when present. */
  latchOutpoint?: string | null
  /** @deprecated Ignored — hardened genesis/resend removed. */
  provenTier?: ProvenTier | null
  /** @deprecated Ignored — hardened genesis/resend removed. */
  recipientIdentityKey?: string | null
  /** @deprecated Ignored — hardened genesis/resend removed. */
  hardenedSendEnabled?: boolean
}

/**
 * Exhaustive send-path choice. Covenant / unknown tips never return `softLatch`.
 * Soft P2PKH → softLatch; everything else refuses with an abandon hint.
 */
export function chooseSendPath(args: ChooseSendPathArgs): SendPath {
  const latch =
    typeof args.latchOutpoint === 'string' && args.latchOutpoint.trim()
      ? toUnderscoreOutpoint(args.latchOutpoint)
      : null

  if (args.tipKind.kind === 'unknown') {
    return { path: 'refuse', reason: 'Collectable locking script is unrecognized' }
  }

  if (args.tipKind.kind === 'covenantLocked') {
    return {
      path: 'refuse',
      reason:
        'This collectable is covenant-locked and can no longer be sent. Abandon it to remove it from inventory.',
    }
  }

  return { path: 'softLatch', latchOutpoint: latch }
}
