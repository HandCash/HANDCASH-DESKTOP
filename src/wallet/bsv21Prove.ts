/**
 * BRC-176 prove(outpoint, beef) for BRC-162 binary BSV-21.
 *
 * Walks token-parent bodies back to a fixed-supply deploy (empty id, amt > 0).
 * Conservation is per token id (I >= O). Missing token-parent bodies fail
 * closed. Funding inputs may be absent from the BEEF. Over-transfer fails.
 * Merge must include every same-id parent. Authority / mint paths are not
 * implemented — amount 0 fails closed.
 */
import { Beef, type Transaction } from '@bsv/sdk'
import {
  decodeBsv21Binary,
  parseDisplayOutpoint,
  type Bsv21Binary,
} from './bsv21Binary'
import { toUnderscoreOutpoint } from './outpointFormat'

const MAX_HOPS = 64

export type Bsv21Proof = {
  ok: true
  tokenId: string
  amount: bigint
  deployOutpoint: string
  role: 'deploy' | 'value'
}

export type Bsv21ProofFailure = {
  ok: false
  reason: string
}

export type Bsv21ProofResult = Bsv21Proof | Bsv21ProofFailure

function fail(reason: string): Bsv21ProofFailure {
  return { ok: false, reason }
}

function asBeef(beef: Beef | number[] | Uint8Array): Beef | null {
  if (beef instanceof Beef) return beef
  try {
    return Beef.fromBinary(beef)
  } catch {
    return null
  }
}

function sourceTxid(input: Transaction['inputs'][number]): string {
  return String(input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '')
    .trim()
    .toLowerCase()
}

function txBody(beef: Beef, txid: string): Transaction | undefined {
  return beef.findTxid(txid)?.tx ?? undefined
}

function decodeOutput(
  tx: Transaction,
  vout: number,
): Bsv21Binary | null {
  const out = tx.outputs[vout]
  if (!out) return null
  return decodeBsv21Binary(out.lockingScript)
}

function tokenIdOf(
  decoded: Bsv21Binary,
  txid: string,
  vout: number,
): string | null {
  if (decoded.tokenId) return decoded.tokenId
  if (decoded.role === 'deploy') return `${txid}_${vout}`
  return null
}

function walk(
  beef: Beef,
  txid: string,
  vout: number,
  seen: Set<string>,
  hops: number,
): Bsv21ProofResult {
  if (hops > MAX_HOPS) return fail('token parent walk exceeded hop limit')
  const key = `${txid}_${vout}`
  if (seen.has(key)) return fail(`cycle in token parent walk at ${key}`)
  seen.add(key)
  try {
    return walkBody(beef, txid, vout, key, seen, hops)
  } finally {
    // Path-scoped: a shared deploy ancestor of a merge is not a cycle.
    seen.delete(key)
  }
}

function walkBody(
  beef: Beef,
  txid: string,
  vout: number,
  key: string,
  seen: Set<string>,
  hops: number,
): Bsv21ProofResult {
  const tx = txBody(beef, txid)
  if (!tx) return fail(`missing token-parent body ${key}`)

  const decoded = decodeOutput(tx, vout)
  if (!decoded) return fail(`output ${key} is not BSV-21 binary`)
  if (decoded.amount === 0n || decoded.role === 'authority') {
    return fail('authority outputs are not proven in this slice')
  }

  if (decoded.role === 'deploy') {
    return {
      ok: true,
      tokenId: key,
      amount: decoded.amount,
      deployOutpoint: key,
      role: 'deploy',
    }
  }

  const tokenId = decoded.tokenId
  if (!tokenId) return fail(`value output ${key} has no token id`)

  const conservation = checkConservation(beef, tx, tokenId)
  if (!conservation.ok) return conservation

  if (conservation.parents.length === 0) {
    return fail(`missing token-parent body for ${tokenId} at ${key}`)
  }

  let deployOutpoint: string | undefined
  for (const parent of conservation.parents) {
    const parentResult = walk(beef, parent.txid, parent.vout, seen, hops + 1)
    if (!parentResult.ok) return parentResult
    if (parentResult.tokenId !== tokenId) {
      return fail(
        `parent ${parent.txid}_${parent.vout} is token ${parentResult.tokenId}, expected ${tokenId}`,
      )
    }
    deployOutpoint = parentResult.deployOutpoint
  }

  if (!deployOutpoint) return fail(`no deploy reached for ${tokenId}`)

  return {
    ok: true,
    tokenId,
    amount: decoded.amount,
    deployOutpoint,
    role: 'value',
  }
}

function checkConservation(
  beef: Beef,
  tx: Transaction,
  tokenId: string,
):
  | { ok: true; parents: { txid: string; vout: number }[]; input: bigint; output: bigint }
  | Bsv21ProofFailure {
  let output = 0n
  for (let i = 0; i < tx.outputs.length; i++) {
    const decoded = decodeOutput(tx, i)
    if (!decoded) continue
    if (decoded.amount === 0n || decoded.role === 'authority') {
      const id = tokenIdOf(decoded, tx.id('hex'), i)
      if (id === tokenId) {
        return fail('authority mint paths are not implemented')
      }
      continue
    }
    const id = tokenIdOf(decoded, tx.id('hex'), i)
    if (id === tokenId) output += decoded.amount
  }

  let input = 0n
  const parents: { txid: string; vout: number }[] = []
  const sameIdMissing: string[] = []

  for (const vin of tx.inputs) {
    const prev = sourceTxid(vin)
    const prevVout = vin.sourceOutputIndex
    if (!/^[0-9a-f]{64}$/.test(prev) || !Number.isInteger(prevVout) || prevVout < 0) {
      continue
    }
    const parentTx = txBody(beef, prev)
    if (!parentTx) {
      // Funding may be absent. A same-id token parent without a body is
      // detected when conservation is short (I < O) or when the BEEF has a
      // txid-only stub for that input.
      const stub = beef.findTxid(prev)
      if (stub && !stub.tx) sameIdMissing.push(`${prev}_${prevVout}`)
      continue
    }
    const decoded = decodeOutput(parentTx, prevVout)
    if (!decoded) continue
    if (decoded.amount === 0n || decoded.role === 'authority') {
      const id = tokenIdOf(decoded, prev, prevVout)
      if (id === tokenId) {
        return fail('authority mint paths are not implemented')
      }
      continue
    }
    const id = tokenIdOf(decoded, prev, prevVout)
    if (id !== tokenId) continue
    input += decoded.amount
    parents.push({ txid: prev, vout: prevVout })
  }

  if (sameIdMissing.length) {
    return fail(`missing token-parent body ${sameIdMissing[0]}`)
  }
  if (parents.length === 0 && output > 0n) {
    return fail(`missing token-parent body for ${tokenId}`)
  }
  if (input < output) {
    return fail(
      `over-transfer: input ${input} < output ${output} for ${tokenId}`,
    )
  }
  return { ok: true, parents, input, output }
}

/**
 * Prove a BRC-162 tip from its BEEF: walk token parents to the fixed-supply
 * deploy and enforce per-id conservation (I >= O).
 */
export function prove(
  outpoint: string,
  beef: Beef | number[] | Uint8Array,
): Bsv21ProofResult {
  const parsed = parseDisplayOutpoint(toUnderscoreOutpoint(outpoint))
  if (!parsed) return fail(`invalid outpoint ${outpoint}`)
  const parsedBeef = asBeef(beef)
  if (!parsedBeef) return fail('invalid BEEF')
  return walk(parsedBeef, parsed.txid, parsed.vout, new Set(), 0)
}
