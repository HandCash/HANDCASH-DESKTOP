/**
 * Explicit tip / send-path vocabulary for collectables.
 *
 * Tip kind, send path, and delayed-proof source are tagged unions so a covenant
 * tip cannot silently fall through to soft-latch, and a latch-basket beacon
 * cannot be typed as a delayed proof. Routing lives in `chooseSendPath`; the
 * XState parent (`collectableSendMachine`) only invokes what that returns.
 */
import {
  BASE_LINK,
  canUseHardenedLatch,
  isHardenedCovenantLockingScript,
  isHardenedSendEnabled,
  parseHardenedTipInstructions,
} from './oneSatHardenedReceive'
import { decodeHardenedLinkOutpoint } from './oneSatHardenedLatch'
import { isValidOutpoint, toUnderscoreOutpoint } from './oneSatLatch'

export type TipKind =
  | { kind: 'hardenedCovenant'; lockingScript: string }
  | { kind: 'softP2pkh'; lockingScript: string }
  | { kind: 'unknown' }

/** Where the delayed prior proof outpoint may come from. Basket latch is not one. */
export type DelayedProofSource = 'remittance' | 'covenantLink' | 'opReturnState'

export type SendPath =
  | { path: 'hardenedGenesis' }
  | {
      path: 'hardenedResend'
      proofOutpoint: string
      proofSource: DelayedProofSource
    }
  | { path: 'softLatch'; latchOutpoint: string | null }
  | { path: 'refuse'; reason: string }

export type ProvenTier = 'brc156' | 'brc150' | 'unproven'

export function classifyTipKind(
  lockingScript: string | undefined | null,
): TipKind {
  const hex = typeof lockingScript === 'string' ? lockingScript.trim() : ''
  if (!hex) return { kind: 'unknown' }
  if (isHardenedCovenantLockingScript(hex)) {
    return { kind: 'hardenedCovenant', lockingScript: hex }
  }
  if (/^76a914[0-9a-f]{40}88ac$/i.test(hex)) {
    return { kind: 'softP2pkh', lockingScript: hex }
  }
  // Non-P2PKH scripts that fail the covenant heuristic stay unknown — refuse
  // rather than guess a spend path.
  if (hex.length >= 80) {
    return { kind: 'hardenedCovenant', lockingScript: hex }
  }
  return { kind: 'unknown' }
}

function isUsableProofOutpoint(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === BASE_LINK) return null
  try {
    const underscored = toUnderscoreOutpoint(trimmed)
    if (!isValidOutpoint(underscored) || underscored === BASE_LINK) return null
    return underscored
  } catch {
    return null
  }
}

/**
 * Resolve the delayed prior proof for a covenant resend.
 *
 * Order is fixed: remittance customInstructions → covenant linkOutpoint →
 * on-chain OP_RETURN latch state. A basket latch / beacon outpoint is never a
 * source — callers must not pass one.
 */
export function resolveDelayedProof(args: {
  remittanceProofOutpoint?: string | null
  tipCustomInstructions?: string | null
  covenantLinkOutpoint?: string | null
  opReturnProofOutpoint?: string | null
}):
  | { proofOutpoint: string; proofSource: DelayedProofSource }
  | { proofOutpoint: null; proofSource: null; reason: string } {
  const fromRemittance =
    isUsableProofOutpoint(args.remittanceProofOutpoint) ??
    isUsableProofOutpoint(
      parseHardenedTipInstructions(args.tipCustomInstructions ?? undefined)
        ?.proofOutpoint,
    )
  if (fromRemittance) {
    return { proofOutpoint: fromRemittance, proofSource: 'remittance' }
  }

  let fromLink: string | null = null
  if (args.covenantLinkOutpoint) {
    const raw = String(args.covenantLinkOutpoint).trim()
    // Already an outpoint (txid_vout / txid.vout) — do not run lineage decode.
    if (raw.includes('_') || raw.includes('.')) {
      fromLink = isUsableProofOutpoint(raw)
    } else {
      try {
        fromLink = isUsableProofOutpoint(decodeHardenedLinkOutpoint(raw))
      } catch {
        fromLink = null
      }
    }
  }
  if (fromLink) {
    return { proofOutpoint: fromLink, proofSource: 'covenantLink' }
  }

  const fromState = isUsableProofOutpoint(args.opReturnProofOutpoint)
  if (fromState) {
    return { proofOutpoint: fromState, proofSource: 'opReturnState' }
  }

  return {
    proofOutpoint: null,
    proofSource: null,
    reason: 'Hardened resend requires the delayed prior proof outpoint',
  }
}

export type ChooseSendPathArgs = {
  tipKind: TipKind
  /** Authenticity tier from proven cache (genesis needs brc150/brc156). */
  provenTier?: ProvenTier | null
  recipientIdentityKey?: string | null
  /** Soft-latch dust outpoint when present — never used as delayed proof. */
  latchOutpoint?: string | null
  tipCustomInstructions?: string | null
  remittanceProofOutpoint?: string | null
  covenantLinkOutpoint?: string | null
  opReturnProofOutpoint?: string | null
  hardenedSendEnabled?: boolean
}

/**
 * Exhaustive send-path choice. Covenant tips never return `softLatch`.
 * Genesis induction needs identity + proven BRC-150/156; otherwise soft-latch
 * (P2PKH) or refuse.
 */
export function chooseSendPath(args: ChooseSendPathArgs): SendPath {
  const hardenedOn = args.hardenedSendEnabled ?? isHardenedSendEnabled()
  const hasIdentity = canUseHardenedLatch({
    publicKey: args.recipientIdentityKey,
  })
  const latch =
    typeof args.latchOutpoint === 'string' && args.latchOutpoint.trim()
      ? toUnderscoreOutpoint(args.latchOutpoint)
      : null

  if (args.tipKind.kind === 'unknown') {
    return { path: 'refuse', reason: 'Collectable locking script is unrecognized' }
  }

  if (args.tipKind.kind === 'hardenedCovenant') {
    if (!hardenedOn) {
      return {
        path: 'refuse',
        reason: 'Hardened BRC-156 send is not enabled',
      }
    }
    if (!hasIdentity) {
      return {
        path: 'refuse',
        reason:
          'Hardened covenant tip requires a recipient identity key (cannot soft-latch)',
      }
    }
    const proof = resolveDelayedProof({
      remittanceProofOutpoint: args.remittanceProofOutpoint,
      tipCustomInstructions: args.tipCustomInstructions,
      covenantLinkOutpoint: args.covenantLinkOutpoint,
      opReturnProofOutpoint: args.opReturnProofOutpoint,
    })
    if (!proof.proofOutpoint || !proof.proofSource) {
      return {
        path: 'refuse',
        reason:
          'reason' in proof && proof.reason
            ? proof.reason
            : 'Hardened resend requires the delayed prior proof outpoint',
      }
    }
    return {
      path: 'hardenedResend',
      proofOutpoint: proof.proofOutpoint,
      proofSource: proof.proofSource,
    }
  }

  // softP2pkh
  const genesisReady =
    args.provenTier === 'brc150' || args.provenTier === 'brc156'
  if (hardenedOn && hasIdentity && genesisReady) {
    return { path: 'hardenedGenesis' }
  }

  return { path: 'softLatch', latchOutpoint: latch }
}
