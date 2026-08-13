/**
 * Explicit tip / send-path vocabulary for collectables.
 *
 * Tip kind and send path are tagged unions so a covenant-locked tip cannot
 * silently fall through to a spendable send. Routing lives in `chooseSendPath`;
 * the XState parent (`collectableSendMachine`) only invokes what that returns.
 *
 * A spendable P2PKH tip is the only send path. Covenant / unknown tips refuse —
 * the UI offers abandon instead of send. Item identity is BRC-150 (offline
 * tip->origin proof); there is no on-chain latch companion.
 */
import { Beef } from '@bsv/sdk'

export type TipKind =
  | { kind: 'covenantLocked'; lockingScript: string }
  | { kind: 'p2pkh'; lockingScript: string }
  | { kind: 'unknown' }

export type SendPath =
  | { path: 'p2pkhSend' }
  | { path: 'refuse'; reason: string }

export type ProvenTier = 'brc150' | 'unproven'

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

/**
 * Read a tip's locking script from BEEF when `listOutputs` omits it.
 *
 * wallet-toolbox IDB `validateOutputScript` no-ops when `scriptOffset === 0`,
 * so `include: 'locking scripts'` often returns no script even for spendable
 * tips. The tip BEEF we already fetch for the send always has the output.
 */
export function lockingScriptHexFromBeef(
  beefBin: number[] | Uint8Array,
  outpoint: string,
): string {
  const dotted = outpoint.trim().replace(/_(\d+)$/, '.$1')
  const [txid, voutRaw] = dotted.split('.')
  const vout = Number(voutRaw)
  if (!txid || !Number.isFinite(vout) || vout < 0) return ''
  try {
    const tx = Beef.fromBinary(beefBin).findTxid(txid)?.tx
    return normalizeLockingScriptHex(
      tx?.outputs[vout]?.lockingScript?.toHex(),
    )
  } catch {
    return ''
  }
}

/** Prefer listOutputs hex; fall back to the tip BEEF body. */
export function resolveTipLockingScriptHex(args: {
  listed: unknown
  beefBin?: number[] | Uint8Array | null
  outpoint: string
}): string {
  const fromList = normalizeLockingScriptHex(args.listed)
  if (fromList) return fromList
  if (!args.beefBin) return ''
  return lockingScriptHexFromBeef(args.beefBin, args.outpoint)
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

  // Spendable tips: bare P2PKH, or inscribed (ord envelope + P2PKH) still
  // unlocked by the device root key — the send spends the P2PKH branch.
  if (hasSpendableP2pkhBranch(hex)) {
    return { kind: 'p2pkh', lockingScript: hex }
  }

  // Long non-P2PKH scripts (legacy covenant tips) cannot be spent by this
  // wallet — they refuse and are abandoned, never sent.
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
  /**
   * BRC-150 authenticity. When listOutputs/BEEF omit the locking script, a
   * verified tip still sends — authenticity is independent of the toolbox
   * scriptOffset bug.
   */
  provenTier?: ProvenTier | null
  /** @deprecated Ignored — hardened genesis/resend removed. */
  recipientIdentityKey?: string | null
  /** @deprecated Ignored — hardened genesis/resend removed. */
  hardenedSendEnabled?: boolean
}

function isAuthenticityProven(tier: ProvenTier | null | undefined): boolean {
  return tier === 'brc150'
}

/**
 * Exhaustive send-path choice. Covenant tips never send.
 * Spendable P2PKH → p2pkhSend. Unknown + BRC-150 proven → p2pkhSend (missing
 * script). Unknown without proof refuses.
 */
export function chooseSendPath(args: ChooseSendPathArgs): SendPath {
  if (args.tipKind.kind === 'covenantLocked') {
    return {
      path: 'refuse',
      reason:
        'This collectable is covenant-locked and can no longer be sent. Abandon it to remove it from inventory.',
    }
  }

  if (args.tipKind.kind === 'unknown') {
    if (isAuthenticityProven(args.provenTier)) {
      return { path: 'p2pkhSend' }
    }
    return { path: 'refuse', reason: 'Collectable locking script is unrecognized' }
  }

  return { path: 'p2pkhSend' }
}
