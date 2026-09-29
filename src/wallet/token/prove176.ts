/**
 * BRC-176 prove(outpoint, beef) for BSV-21.
 *
 * Walks token-parent bodies back to a fixed-supply deploy (empty id, amt > 0).
 * Conservation is per token id (I >= O). Missing token-parent bodies fail
 * closed. Funding inputs may be absent from the BEEF. Over-transfer fails.
 * Merge must include every same-id parent.
 *
 * Both encodings are decoded (BRC-176 §validity: "decode both BRC-161 JSON and
 * BRC-162 binary; a lineage may mix them"). BRC-162 binary wins when an
 * output carries both. Authority / mint paths are not implemented — a
 * `deploy+auth`, `auth`, `mint` or amount-0 output on the path fails closed.
 * A burn output counts toward O and, as a spent input, contributes nothing.
 */
import { Beef, type Transaction } from '@bsv/sdk'
import { decodeBsv21Binary, parseDisplayOutpoint } from './decode162'
import { parseOrdEnvelope } from '../ordinalOwnership'
import { toUnderscoreOutpoint } from '../outpointFormat'
import { BSV21_PROTOCOL, normalizeTokenId } from './types'

/**
 * Longest token-parent chain (deploy → tip) prove will walk. Every hop needs
 * a body, so this bounds recursion, not history: a token transferred more
 * than this many times in a straight line reads `unproven`, never counterfeit.
 */
export const MAX_PROVE_DEPTH = 256
/** Distinct transaction bodies a fill / ancestry collection will hold. */
export const MAX_PACKET_TXS = 2048
export const PARENT_FILL_DEADLINE_MS = 20_000

export type Bsv21Proof = {
  ok: true
  tokenId: string
  amount: bigint
  deployOutpoint: string
  role: 'deploy' | 'value'
  /** Wire encoding of the proven tip itself. */
  encoding: 'binary' | 'json'
}

export type Bsv21ProofFailure = {
  ok: false
  reason: string
}

export type Bsv21ProofResult = Bsv21Proof | Bsv21ProofFailure

/** Encoding-neutral view of one BSV-21 output for the walk. */
export type TokenOutput = {
  role: 'deploy' | 'value' | 'authority' | 'burn'
  /** Absent on deploy (the outpoint is the id). */
  tokenId?: string
  amount: bigint
  encoding: 'binary' | 'json'
}

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

const UINT64_RE = /^\d{1,20}$/

function decodeJsonTokenOutput(scriptHex: string): TokenOutput | null {
  const envelope = parseOrdEnvelope(scriptHex)
  if (!envelope?.body?.length) return null
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(envelope.body))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.p !== BSV21_PROTOCOL) return null
  const op = typeof o.op === 'string' ? o.op.trim() : ''
  const amtRaw =
    typeof o.amt === 'string'
      ? o.amt.trim()
      : typeof o.amt === 'number' && Number.isFinite(o.amt)
        ? String(Math.trunc(o.amt))
        : ''
  const amount = UINT64_RE.test(amtRaw) ? BigInt(amtRaw) : null
  const tokenId = typeof o.id === 'string' ? normalizeTokenId(o.id) ?? undefined : undefined
  switch (op) {
    case 'deploy+mint':
      if (amount == null) return null
      return { role: 'deploy', amount, encoding: 'json' }
    case 'transfer':
      if (amount == null || !tokenId) return null
      return { role: 'value', tokenId, amount, encoding: 'json' }
    case 'burn':
      if (amount == null || !tokenId) return null
      return { role: 'burn', tokenId, amount, encoding: 'json' }
    case 'deploy+auth':
    case 'auth':
    case 'mint':
      return { role: 'authority', ...(tokenId ? { tokenId } : {}), amount: amount ?? 0n, encoding: 'json' }
    default:
      return null
  }
}

/**
 * Decode a BSV-21 output in either encoding. Binary wins when both are
 * present (BRC-162 §"binary wins").
 */
export function decodeTokenOutput(script: { toHex(): string } | string | undefined): TokenOutput | null {
  if (!script) return null
  const hex = typeof script === 'string' ? script : script.toHex()
  const binary = decodeBsv21Binary(hex)
  if (binary) {
    if (binary.role === 'authority' || binary.amount === 0n) {
      return { role: 'authority', ...(binary.tokenId ? { tokenId: binary.tokenId } : {}), amount: binary.amount, encoding: 'binary' }
    }
    if (binary.role === 'deploy') return { role: 'deploy', amount: binary.amount, encoding: 'binary' }
    if (!binary.tokenId) return null
    return { role: 'value', tokenId: binary.tokenId, amount: binary.amount, encoding: 'binary' }
  }
  return decodeJsonTokenOutput(hex)
}

function decodeOutput(tx: Transaction, vout: number): TokenOutput | null {
  const out = tx.outputs[vout]
  if (!out) return null
  return decodeTokenOutput(out.lockingScript)
}

function isTokenOutput(tx: Transaction, vout: number): boolean {
  return decodeOutput(tx, vout) != null
}

/**
 * Pull raw token-parent bodies into a BEEF without waiting for merkle proofs.
 *
 * A first send of an unmined 162 genesis often returns AtomicBEEF that only
 * has the new transfer (txid-only parents). Prove needs the deploy body.
 * Funding inputs are fetched once so we can tell them from token parents,
 * then left out of the walk.
 */
export async function fillTokenParentBodies(
  beef: Beef,
  fetchBody: (txid: string) => Promise<Beef | null | undefined>,
  startTxids: string[],
): Promise<Beef> {
  const work = beef.clone()
  work.atomicTxid = undefined
  const queue = [
    ...new Set(
      startTxids
        .map((txid) => txid.trim().toLowerCase())
        .filter((txid) => /^[0-9a-f]{64}$/.test(txid)),
    ),
  ]
  const seen = new Set<string>()
  const deadline = Date.now() + PARENT_FILL_DEADLINE_MS

  const ensureBody = async (txid: string): Promise<Transaction | undefined> => {
    const existing = work.findTxid(txid)?.tx
    if (existing) return existing
    if (Date.now() >= deadline) return undefined
    try {
      const extra = await fetchBody(txid)
      if (!extra) return undefined
      work.mergeBeef(extra.toBinary())
      work.atomicTxid = undefined
    } catch {
      return undefined
    }
    return work.findTxid(txid)?.tx
  }

  while (queue.length && seen.size < MAX_PACKET_TXS) {
    const txid = queue.shift()
    if (!txid || seen.has(txid)) continue
    seen.add(txid)
    const tx = await ensureBody(txid)
    if (!tx) continue
    for (const vin of tx.inputs) {
      const prev = sourceTxid(vin)
      const prevVout = vin.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(prev)) continue
      if (seen.has(prev)) continue
      const parentTx = await ensureBody(prev)
      if (!parentTx) continue
      if (isTokenOutput(parentTx, prevVout)) queue.push(prev)
    }
  }

  return work
}

function tokenIdOf(decoded: TokenOutput, txid: string, vout: number): string | null {
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
  if (hops > MAX_PROVE_DEPTH) {
    return fail(`token parent walk exceeded depth limit ${MAX_PROVE_DEPTH}`)
  }
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
  if (!decoded) return fail(`output ${key} is not BSV-21`)
  if (decoded.role === 'authority' || decoded.amount === 0n) {
    return fail('authority outputs are not proven in this slice')
  }
  if (decoded.role === 'burn') return fail(`burn output ${key} holds no value`)

  if (decoded.role === 'deploy') {
    return {
      ok: true,
      tokenId: key,
      amount: decoded.amount,
      deployOutpoint: key,
      role: 'deploy',
      encoding: decoded.encoding,
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
    encoding: decoded.encoding,
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
  const txid = tx.id('hex')
  for (let i = 0; i < tx.outputs.length; i++) {
    const decoded = decodeOutput(tx, i)
    if (!decoded) continue
    const id = tokenIdOf(decoded, txid, i)
    if (id !== tokenId) continue
    if (decoded.role === 'authority' || decoded.amount === 0n) {
      return fail('authority mint paths are not implemented')
    }
    // Value and burn both leave the input pool (BRC-176: burn counts toward O).
    output += decoded.amount
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
    const id = tokenIdOf(decoded, prev, prevVout)
    if (id !== tokenId) continue
    if (decoded.role === 'authority' || decoded.amount === 0n) {
      return fail('authority mint paths are not implemented')
    }
    // A spent burn contributes nothing; it is not a parent to walk either.
    if (decoded.role === 'burn') continue
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
 * Prove a BSV-21 tip from its BEEF: walk token parents to the fixed-supply
 * deploy and enforce per-id conservation (I >= O).
 *
 * Token rules only. Bitcoin validity (merkle paths, script) is the toolbox's
 * verify on `internalizeAction` / `processAction`; callers admit a tip when
 * both hold.
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

/**
 * Exact transaction chain whose BSV-21 outputs authorize these spend tips.
 *
 * Funding ancestors are deliberately excluded. Callers use this before
 * signing to ask Arcade whether any token ancestor is objectively rejected;
 * an unrelated cash-history row must not make token validity fail.
 */
export function collectBsv21TokenAncestryTxids(args: {
  outpoints: string[]
  tokenId: string
  beef: Beef | number[] | Uint8Array
}): string[] {
  const parsedBeef = asBeef(args.beef)
  if (!parsedBeef) throw new Error('invalid token-parent BEEF')
  const tokenId = args.tokenId.trim().toLowerCase()
  const queue: string[] = []
  for (const outpoint of args.outpoints) {
    const proof = prove(outpoint, parsedBeef)
    if (!proof.ok) throw new Error(`BRC-176 prove failed: ${proof.reason}`)
    if (proof.tokenId !== tokenId) {
      throw new Error(`token tip is ${proof.tokenId}, expected ${tokenId}`)
    }
    const parsed = parseDisplayOutpoint(toUnderscoreOutpoint(outpoint))
    if (!parsed) throw new Error(`invalid outpoint ${outpoint}`)
    queue.push(parsed.txid)
  }

  const ancestry = new Set<string>()
  while (queue.length > 0 && ancestry.size < MAX_PACKET_TXS) {
    const txid = queue.shift()
    if (!txid || ancestry.has(txid)) continue
    ancestry.add(txid)
    const tx = txBody(parsedBeef, txid)
    if (!tx) throw new Error(`missing token transaction body ${txid}`)
    for (const input of tx.inputs) {
      const parentTxid = sourceTxid(input)
      const parentVout = input.sourceOutputIndex
      const parentTx = txBody(parsedBeef, parentTxid)
      if (!parentTx) continue
      const decoded = decodeOutput(parentTx, parentVout)
      if (!decoded || decoded.role === 'burn') continue
      if (tokenIdOf(decoded, parentTxid, parentVout) === tokenId) {
        queue.push(parentTxid)
      }
    }
  }
  if (queue.length > 0) {
    throw new Error(`token ancestry exceeded packet limit ${MAX_PACKET_TXS}`)
  }
  return [...ancestry]
}
