import { Transaction, Utils } from '@bsv/sdk'
import { decodeCountersignPayload, type CountersignDeployFields, type CountersignKind } from './payload'
import {
  beaconLock,
  HOLDER_SCOPE,
  holderScopeOf,
  holderSignatureValid,
  inputScriptValid,
  readCountersigned,
  readHolderUnlock,
  sameKeySets,
  sourceOutputOf,
  sourceTxidOf,
  SWAP_HOLDER_SCOPE,
  type CountersignKeySets,
  type CountersignedOutput,
} from './script'

export type CountersignDeploy = {
  assetId: string
  kind: CountersignKind
  supply: string
  sets: CountersignKeySets
  fields: CountersignDeployFields
}

/**
 * Read a deploy body. The asset id is output 0; output 1 must be the first
 * beacon; an item has a supply of one and no decimals.
 */
export function readCountersignDeploy(tx: Transaction): CountersignDeploy | null {
  const out0 = tx.outputs[0]?.lockingScript
  const out1 = tx.outputs[1]?.lockingScript
  if (!out0 || !out1) return null
  const read = readCountersigned(out0)
  if (!read || read.assetId != null || !read.payload) return null
  const fields = decodeCountersignPayload(read.payload)
  if (!fields) return null
  if (out1.toHex() !== beaconLock(read.sets).toHex()) return null
  if (fields.kind === 'item' && read.amount !== 1n) return null
  return {
    assetId: `${String(tx.id('hex')).toLowerCase()}_0`,
    kind: fields.kind,
    supply: read.amount.toString(),
    sets: read.sets,
    fields,
  }
}

type InputAsset = { assetId: string; read: CountersignedOutput; outpoint: string }

/**
 * The asset an input spends. A held output names its asset; a deploy output
 * is that asset by its own outpoint.
 */
export function assetOfInput(
  tx: Transaction,
  vin: number,
  deploys: ReadonlyMap<string, CountersignDeploy>,
): InputAsset | null {
  const source = sourceOutputOf(tx, vin)
  if (!source) return null
  const read = readCountersigned(source.lockingScript)
  if (!read) return null
  const outpoint = `${sourceTxidOf(tx, vin)}_${tx.inputs[vin]!.sourceOutputIndex}`
  const assetId = read.assetId ?? (deploys.has(outpoint) ? outpoint : null)
  return assetId ? { assetId, read, outpoint } : null
}

export type ResolvedHolding = { vout: number; assetId: string; amount: bigint }

export type ResolveRefusal =
  | 'input'
  | 'output'
  | 'deploy'
  | 'conservation'
  | 'item-supply'
  | 'unknown-asset'

export type ResolveResult =
  | { ok: true; mine: ResolvedHolding[]; assetIds: string[] }
  | { ok: false; reason: ResolveRefusal; detail: string }

/**
 * Offline resolution from one Extended Format transaction: every input of a
 * known asset script-checks against its claimed source, every output keeps
 * the clause and key sets, amounts are conserved, an item stays one, and an
 * asset is never written without being spent.
 */
export function resolveCountersignTransfer(
  tx: Transaction,
  deploys: ReadonlyMap<string, CountersignDeploy>,
  /** Holder pubkey hashes this wallet holds: its identity hash and the `p color` children it can derive. */
  heldHashes?: ReadonlySet<string>,
): ResolveResult {
  const ins = new Map<string, bigint>()
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const source = sourceOutputOf(tx, vin)
    if (!source) return { ok: false, reason: 'input', detail: `input ${vin} carries no source output` }
    const read = readCountersigned(source.lockingScript)
    if (!read) continue
    const asset = assetOfInput(tx, vin, deploys)
    const deploy = asset ? deploys.get(asset.assetId) : undefined
    if (!asset || !deploy) {
      return { ok: false, reason: 'unknown-asset', detail: `input ${vin} spends an asset with no deploy body` }
    }
    if (!sameKeySets(read.sets, deploy.sets) || !inputScriptValid(tx, vin)) {
      return { ok: false, reason: 'input', detail: `input ${vin} is not a countersigned spend of ${asset.assetId}` }
    }
    ins.set(asset.assetId, (ins.get(asset.assetId) ?? 0n) + read.amount)
  }
  const outs = new Map<string, bigint>()
  const mine: ResolvedHolding[] = []
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const script = tx.outputs[vout]!.lockingScript
    const read = script ? readCountersigned(script) : null
    if (!read) continue
    const deploy = read.assetId ? deploys.get(read.assetId) : undefined
    if (!read.assetId || !deploy) {
      return { ok: false, reason: 'deploy', detail: `output ${vout} writes an asset no input spends` }
    }
    if (!sameKeySets(read.sets, deploy.sets)) {
      return { ok: false, reason: 'output', detail: `output ${vout} names other key sets` }
    }
    outs.set(read.assetId, (outs.get(read.assetId) ?? 0n) + read.amount)
    if (heldHashes?.has(read.holderPkhHex)) {
      mine.push({ vout, assetId: read.assetId, amount: read.amount })
    }
  }
  for (const [assetId, total] of outs) {
    if (!ins.has(assetId)) return { ok: false, reason: 'deploy', detail: `${assetId} is written without being spent` }
    if (total !== ins.get(assetId)) {
      return { ok: false, reason: 'conservation', detail: `${assetId} sums ${total} out of ${ins.get(assetId)}` }
    }
    if (deploys.get(assetId)!.kind === 'item' && total !== 1n) {
      return { ok: false, reason: 'item-supply', detail: `${assetId} is an item written ${total} times` }
    }
  }
  return { ok: true, mine, assetIds: [...outs.keys()] }
}

/** Acceptor reply codes. */
export type AcceptRefusal =
  | 'unknown_input'
  | 'spent'
  | 'invalid'
  | 'frozen'
  | 'recipient'
  | 'limit'
  | 'fee'
  | 'policy'
  | 'not_acceptor'
  /** Holder-side only: refusals left fewer cosigners than the threshold. */
  | 'quorum'

export type AcceptCheck =
  | { ok: true; assetIds: string[]; inputs: string[] }
  | { ok: false; reason: AcceptRefusal; detail: string }

/**
 * The acceptor's checks before it countersigns: every input is an accepted,
 * unreserved output of an asset this acceptor answers for, signed by its
 * holder ALL|ANYONECANPAY; every output keeps the clause, carries one
 * satoshi, and pays either the holder hash a recipient entry proved or an
 * input's holder back; amounts are conserved.
 *
 * A sender-funded request (`swap`) is a trade: plain outputs (a seller's
 * payment, an offer token, change) may sit beside the asset outputs, and a
 * selling holder may sign SINGLE|ANYONECANPAY, which binds its input to the
 * plain output at the same index.
 */
export function checkAcceptRequest(args: {
  tx: Transaction
  deploys: ReadonlyMap<string, CountersignDeploy>
  answersFor: (assetId: string) => boolean
  accepted: ReadonlySet<string>
  reservedBy: (outpoint: string) => string | undefined
  requestId: string
  /** Holder pubkey hash per listed output, already proven from the request's linkage. */
  recipients: ReadonlyArray<{ vout: number; holderPkhHex: string }>
  frozen?: (holderPkhHex: string) => boolean
  /**
   * Quorum requests: the holder's own fee inputs follow the asset inputs.
   * They are plain outputs, never countersigned ones, and never come first.
   */
  holderFunded?: boolean
  /** Sender-funded trade: implies `holderFunded`, admits plain outputs and SINGLE|ANYONECANPAY holders. */
  swap?: boolean
}): AcceptCheck {
  const { tx } = args
  const funded = args.holderFunded || args.swap
  if (tx.inputs.length === 0) return { ok: false, reason: 'invalid', detail: 'no inputs' }
  const ins = new Map<string, bigint>()
  const inputs: string[] = []
  const senders = new Set<string>()
  let feeFrom: number | null = null
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const asset = assetOfInput(tx, vin, args.deploys)
    if (!asset && funded && vin > 0) {
      const source = sourceOutputOf(tx, vin)
      if (source && !readCountersigned(source.lockingScript)) {
        feeFrom ??= vin
        continue
      }
    }
    if (!asset) return { ok: false, reason: 'invalid', detail: `input ${vin} is not a countersigned output` }
    if (feeFrom != null) return { ok: false, reason: 'invalid', detail: `input ${vin} follows the fee inputs` }
    if (!args.answersFor(asset.assetId)) return { ok: false, reason: 'not_acceptor', detail: asset.assetId }
    const deploy = args.deploys.get(asset.assetId)!
    if (!sameKeySets(asset.read.sets, deploy.sets)) {
      return { ok: false, reason: 'invalid', detail: `input ${vin} names other key sets` }
    }
    if (!args.accepted.has(asset.outpoint)) {
      return { ok: false, reason: 'unknown_input', detail: asset.outpoint }
    }
    const holder = args.reservedBy(asset.outpoint)
    if (holder && holder !== args.requestId) return { ok: false, reason: 'spent', detail: asset.outpoint }
    if (!holderSignatureValid(tx, vin, asset.read.holderPkhHex, args.swap ? [HOLDER_SCOPE, SWAP_HOLDER_SCOPE] : [HOLDER_SCOPE])) {
      return { ok: false, reason: 'invalid', detail: `input ${vin} holder signature` }
    }
    if (holderScopeOf(tx, vin) === SWAP_HOLDER_SCOPE) {
      const bound = tx.outputs[vin]?.lockingScript
      if (!bound || readCountersigned(bound)) {
        return { ok: false, reason: 'invalid', detail: `input ${vin} binds no plain payment output` }
      }
    }
    if (args.frozen?.(asset.read.holderPkhHex)) return { ok: false, reason: 'frozen', detail: asset.outpoint }
    ins.set(asset.assetId, (ins.get(asset.assetId) ?? 0n) + asset.read.amount)
    inputs.push(asset.outpoint)
    senders.add(asset.read.holderPkhHex)
  }
  const named = new Map(args.recipients.map((r) => [r.vout, r.holderPkhHex]))
  const outs = new Map<string, bigint>()
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const output = tx.outputs[vout]!
    const read = output.lockingScript ? readCountersigned(output.lockingScript) : null
    if (!read && args.swap && output.lockingScript) continue
    if (!read?.assetId || !ins.has(read.assetId)) {
      return { ok: false, reason: 'invalid', detail: `output ${vout} is not an output of a spent asset` }
    }
    if (!sameKeySets(read.sets, args.deploys.get(read.assetId)!.sets)) {
      return { ok: false, reason: 'invalid', detail: `output ${vout} names other key sets` }
    }
    if (output.satoshis !== 1) return { ok: false, reason: 'invalid', detail: `output ${vout} carries ${output.satoshis} satoshis` }
    const recipient = named.get(vout)
    if (recipient ? recipient !== read.holderPkhHex : !senders.has(read.holderPkhHex)) {
      return { ok: false, reason: 'recipient', detail: `output ${vout} pays no named recipient` }
    }
    outs.set(read.assetId, (outs.get(read.assetId) ?? 0n) + read.amount)
  }
  for (const [assetId, total] of ins) {
    if (outs.get(assetId) !== total) {
      return { ok: false, reason: 'invalid', detail: `${assetId} is not conserved` }
    }
    if (args.deploys.get(assetId)!.kind === 'item' && total !== 1n) {
      return { ok: false, reason: 'invalid', detail: `${assetId} is an item` }
    }
  }
  return { ok: true, assetIds: [...ins.keys()], inputs }
}

/** Outpoints of the inputs that spend no countersigned output: fee and payment coins, offer tokens. */
export function plainInputsOf(tx: Transaction): string[] {
  const plain: string[] = []
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const source = sourceOutputOf(tx, vin)
    if (source && readCountersigned(source.lockingScript)) continue
    plain.push(`${sourceTxidOf(tx, vin)}_${tx.inputs[vin]!.sourceOutputIndex}`)
  }
  return plain
}

/** A request this acceptor already signed that spends a given asset input. */
export type PriorSpend = {
  requestId: string
  plainInputs: readonly string[]
  /** The requester funds and broadcasts it, so it dies when one of its plain inputs is spent elsewhere. */
  requesterFunded: boolean
  /**
   * Its holder sold this input SINGLE|ANYONECANPAY against a payment in the
   * same transaction. A later spend can only void that sale, never cost the
   * buyer anything, so it reserves nothing.
   */
  sale?: boolean
}

/**
 * The earlier signed spends of one input that still stop a new request from
 * spending it. A sale, or one that shares a plain input with the new request,
 * conflicts with it: at most one of the two confirms and the loser loses
 * nothing. Any other stops it until proven dead; one this acceptor funded and
 * broadcast never dies.
 */
export function blockingPriorSpends(prior: readonly PriorSpend[], request: Transaction): {
  conflicting: PriorSpend[]
  maybeDead: PriorSpend[]
  final: PriorSpend[]
} {
  const mine = new Set(plainInputsOf(request))
  const conflicting: PriorSpend[] = []
  const maybeDead: PriorSpend[] = []
  const final: PriorSpend[] = []
  for (const spend of prior) {
    if (spend.sale || spend.plainInputs.some((outpoint) => mine.has(outpoint))) conflicting.push(spend)
    else if (spend.requesterFunded) maybeDead.push(spend)
    else final.push(spend)
  }
  return { conflicting, maybeDead, final }
}

/** Holder public key of input `vin`, from its pre-acceptance unlock. */
export function holderKeyOf(tx: Transaction, vin: number): string | null {
  const holder = readHolderUnlock(tx.inputs[vin]?.unlockingScript)
  return holder ? Utils.toHex(holder.publicKey) : null
}
