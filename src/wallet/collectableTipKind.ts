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

/** Bare or embedded P2PKH locking branch: `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`. */
const P2PKH_BRANCH = /76a914[0-9a-f]{40}88ac/i

/**
 * Coerce wallet / SDK locking scripts to lowercase hex.
 * Accepts plain hex, optional `0x` prefix, or objects with `toHex()`.
 */
export function normalizeLockingScriptHex(
  lockingScript: unknown,
): string {
  if (lockingScript == null) return ''
  if (typeof lockingScript === 'string') {
    let hex = lockingScript.trim()
    if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
    return hex
  }
  if (
    typeof lockingScript === 'object' &&
    lockingScript !== null &&
    'toHex' in lockingScript &&
    typeof (lockingScript as { toHex: unknown }).toHex === 'function'
  ) {
    try {
      return normalizeLockingScriptHex(
        (lockingScript as { toHex: () => string }).toHex(),
      )
    } catch {
      return ''
    }
  }
  return ''
}

/** True when hex contains a P2PKH branch on a byte boundary. */
export function hasSpendableP2pkhBranch(scriptHex: string): boolean {
  const script = scriptHex.trim().toLowerCase()
  if (!script || script.length % 2 !== 0 || !/^[0-9a-f]+$/.test(script)) {
    return false
  }
  // P2PKH branch is exactly 25 bytes → 50 hex chars. Inscription content must
  // not spoof a match off a byte boundary.
  for (let i = 0; i + 50 <= script.length; i += 2) {
    if (P2PKH_BRANCH.test(script.slice(i, i + 50))) return true
  }
  return false
}

export function classifyTipKind(
  lockingScript: unknown,
): TipKind {
  const hex = normalizeLockingScriptHex(lockingScript)
  if (!hex) return { kind: 'unknown' }

  // Soft tips: bare P2PKH, or inscribed (ord envelope + P2PKH) still unlocked
  // by the device root key — soft-latch spends the P2PKH branch.
  if (hasSpendableP2pkhBranch(hex)) {
    return { kind: 'softP2pkh', lockingScript: hex }
  }

  // Long non-P2PKH scripts (legacy BRC-156 covenant tips) cannot soft-latch.
  if (hex.length >= 80 && /^[0-9a-f]+$/i.test(hex)) {
    return { kind: 'covenantLocked', lockingScript: hex }
  }
  return { kind: 'unknown' }
}

/** True when the locking script is a covenant / non-P2PKH stuck tip candidate. */
export function isCovenantLockedScript(
  scriptHex: unknown,
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
