/**
 * Browser-safe BRC-156 hardened receive helpers.
 * No scrypt-ts / node:path — safe for the Vite renderer bundle.
 */
import { P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import {
  isValidOriginScriptHash,
  toUnderscoreOutpoint,
  type LatchState,
  type ProvenanceVerifyResult,
} from './oneSatLatch'

export const BASE_LINK = `${'00'.repeat(32)}_0`

/**
 * Live wallet hardened Commit/Settle is enabled. Soft-latch remains the
 * fallback when the recipient has no identity key.
 */
export function isHardenedSendEnabled(): boolean {
  return true
}

export function canUseHardenedLatch(recipient: {
  publicKey?: string | null
  address?: string | null
}): boolean {
  const pk = recipient.publicKey?.trim()
  if (!pk) return false
  try {
    PublicKey.fromString(pk)
    return pk.length === 66 && /^[0-9a-f]+$/i.test(pk)
  } catch {
    return false
  }
}

/**
 * Hardened Commit and Settle reach the network only in the final
 * `signAction({ sendWith })`. A failure before that point has spent nothing, so
 * the caller may still deliver the item over soft-latch / BRC-150 instead of
 * failing the send. A failure at or after the broadcast must surface: retrying
 * the same tip would race a covenant pair that is already on the wire.
 */
const BROADCAST_ATTEMPTED = Symbol.for('handcash.brc156.broadcastAttempted')

export function markHardenedBroadcastAttempted(err: unknown): void {
  if (err != null && typeof err === 'object') {
    ;(err as Record<symbol, unknown>)[BROADCAST_ATTEMPTED] = true
  }
}

export function hardenedBroadcastWasAttempted(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    (err as Record<symbol, unknown>)[BROADCAST_ATTEMPTED] === true
  )
}

/** True when a locking script is a covenant candidate (not P2PKH). */
export function isHardenedCovenantLockingScript(
  scriptHex: string | undefined | null,
): boolean {
  if (!scriptHex) return false
  const hex = scriptHex.trim().toLowerCase()
  if (/^76a914[0-9a-f]{40}88ac$/.test(hex)) return false
  return hex.length >= 80
}

export function parseHardenedTipInstructions(raw: string | undefined): {
  mode: 'hardened'
  originScriptHash?: string
  proofOutpoint?: string
  commitTxid?: string
} | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o.mode !== 'hardened') return null
    return {
      mode: 'hardened',
      originScriptHash:
        typeof o.originScriptHash === 'string' ? o.originScriptHash : undefined,
      proofOutpoint:
        typeof o.proofOutpoint === 'string' ? o.proofOutpoint : undefined,
      commitTxid: typeof o.commitTxid === 'string' ? o.commitTxid : undefined,
    }
  } catch {
    return null
  }
}

function inputOutpoint(tx: Transaction, index: number): string {
  const input = tx.inputs[index]
  if (!input || input.sourceTXID == null) {
    throw new Error(`missing input ${index}`)
  }
  const txid = String(input.sourceTXID).toLowerCase()
  if (!txid || txid.length !== 64) throw new Error(`missing input ${index}`)
  return `${txid}_${input.sourceOutputIndex}`
}

export type AlternatingVerifyArgs = {
  currentOutpoint: string
  delayedProofOutpoint: string
  currentCommitTxHex: string
  priorSettleTxHex: string
  proofCommitTxHex: string
  currentSettleTxHex: string
  /** Txids whose chain inclusion was verified by headers + Merkle proofs. */
  spvVerifiedTxids: ReadonlySet<string>
  recipientPublicKeyHex: string
}

/** O(1) Tx4-style verifier: current Settle + Commit + prior Settle + proof Commit. */
export function verifyAlternatingProofBounded(
  args: AlternatingVerifyArgs,
): ProvenanceVerifyResult {
  try {
    const settle = Transaction.fromHex(args.currentSettleTxHex)
    const commit = Transaction.fromHex(args.currentCommitTxHex)
    const priorSettle = Transaction.fromHex(args.priorSettleTxHex)
    const proofCommit = Transaction.fromHex(args.proofCommitTxHex)
    const settleId = settle.id('hex').toLowerCase()
    const commitId = commit.id('hex').toLowerCase()
    const priorSettleId = priorSettle.id('hex').toLowerCase()
    const proofCommitId = proofCommit.id('hex').toLowerCase()
    const currentTxid = toUnderscoreOutpoint(args.currentOutpoint).split('_')[0]!
    const proof = toUnderscoreOutpoint(args.delayedProofOutpoint)
    const [proofTxid, proofVout] = proof.split('_')

    for (const id of [settleId, commitId, priorSettleId, proofCommitId]) {
      if (!args.spvVerifiedTxids.has(id)) {
        return { proven: false, reason: `missing SPV inclusion for ${id}` }
      }
    }
    if (settleId !== currentTxid.toLowerCase()) {
      return { proven: false, reason: 'current settle txid mismatch' }
    }
    if (inputOutpoint(settle, 0) !== `${commitId}_0`) {
      return { proven: false, reason: 'settle does not spend current Commit token' }
    }
    if (inputOutpoint(settle, 1) !== proof) {
      return { proven: false, reason: 'settle does not consume delayed proof' }
    }
    if (inputOutpoint(commit, 0) !== `${priorSettleId}_0`) {
      return { proven: false, reason: 'current Commit not linked to prior Settle' }
    }
    if (inputOutpoint(priorSettle, 0) !== `${proofCommitId}_0`) {
      return { proven: false, reason: 'prior Settle not linked to proof Commit token' }
    }
    if (proofTxid !== proofCommitId || proofVout !== '1') {
      return { proven: false, reason: 'delayed proof is not proof Commit vout1' }
    }
    if (settle.outputs[0]?.satoshis !== 1 || settle.outputs[1]?.satoshis !== 2) {
      return { proven: false, reason: 'invalid tip/beacon values' }
    }
    const expectedBeacon = new P2PKH()
      .lock(PublicKey.fromString(args.recipientPublicKeyHex).toHash())
      .toHex()
    if (settle.outputs[1]!.lockingScript.toHex() !== expectedBeacon) {
      return { proven: false, reason: 'beacon recipient mismatch' }
    }
    return { proven: true, reason: null }
  } catch (e) {
    return { proven: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Derive the two delayed-proof context txids from the current Commit + state.
 * proofCommit = tx that created proofOutpoint; priorSettle = Commit vin0.
 */
export function resolveAlternatingProofContext(args: {
  commitTxHex: string
  proofOutpoint: string
}): { proofCommitTxid: string; priorSettleTxid: string } | null {
  try {
    const commit = Transaction.fromHex(args.commitTxHex)
    const proof = toUnderscoreOutpoint(args.proofOutpoint)
    const proofCommitTxid = proof.split('_')[0]
    if (!proofCommitTxid || proofCommitTxid.length !== 64) return null
    const prior = inputOutpoint(commit, 0)
    const priorSettleTxid = prior.split('_')[0]
    if (!priorSettleTxid || priorSettleTxid.length !== 64) return null
    return { proofCommitTxid, priorSettleTxid }
  } catch {
    return null
  }
}

export type HardenedReceiveArgs = {
  settleTxHex: string
  tipVout: number
  recipientPublicKeyHex: string
  state: LatchState
  commitTxHex: string
  priorSettleTxHex?: string
  proofCommitTxHex?: string
  /** When the caller already verified AtomicBEEF inclusion for these txs. */
  trustProvidedTxs?: boolean
}

/**
 * Bounded receive verify for schema-2 alternating proofs.
 * Requires the fixed Tx set: Settle, Commit, prior Settle, delayed-proof Commit.
 */
export function verifyHardenedReceive(
  args: HardenedReceiveArgs,
): ProvenanceVerifyResult & { originScriptHash?: string } {
  if (args.state.schema !== 2 || args.state.mode !== 'hardened') {
    return { proven: false, reason: 'not hardened schema-2 state' }
  }
  if (!args.state.originScriptHash || !isValidOriginScriptHash(args.state.originScriptHash)) {
    return { proven: false, reason: 'missing originScriptHash' }
  }
  const delayed =
    args.state.proofOutpoint ??
    (args.state.parentLatch && args.state.parentLatch !== BASE_LINK
      ? args.state.parentLatch
      : null)
  if (!delayed || !args.priorSettleTxHex || !args.proofCommitTxHex) {
    return {
      proven: false,
      reason: 'alternating proof requires delayed proof + prior settle + proof commit',
    }
  }

  try {
    const settle = Transaction.fromHex(args.settleTxHex)
    const commit = Transaction.fromHex(args.commitTxHex)
    const priorSettle = Transaction.fromHex(args.priorSettleTxHex)
    const proofCommit = Transaction.fromHex(args.proofCommitTxHex)
    const tipOutpoint = `${settle.id('hex')}_${args.tipVout}`
    const spv = new Set(
      [settle, commit, priorSettle, proofCommit].map((tx) => tx.id('hex').toLowerCase()),
    )
    const result = verifyAlternatingProofBounded({
      currentOutpoint: tipOutpoint,
      delayedProofOutpoint: delayed,
      currentCommitTxHex: args.commitTxHex,
      priorSettleTxHex: args.priorSettleTxHex,
      proofCommitTxHex: args.proofCommitTxHex,
      currentSettleTxHex: args.settleTxHex,
      spvVerifiedTxids: spv,
      recipientPublicKeyHex: args.recipientPublicKeyHex,
    })
    return {
      ...result,
      originScriptHash: args.state.originScriptHash.toLowerCase(),
    }
  } catch (e) {
    return {
      proven: false,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}
