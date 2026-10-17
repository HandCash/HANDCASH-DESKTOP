import {
  Hash,
  LockingScript,
  OP,
  PrivateKey,
  PublicKey,
  Script,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type ScriptChunk,
} from '@bsv/sdk'
import { decodeBsv21Binary, encodeBsv21Binary, encodeScriptNumber } from '../token/decode162'

/**
 * Countersigned assets (unpublished issuer-control draft): a BRC-162 prefix
 * followed by a clause that needs the holder's signature and an acceptor
 * quorum's. The acceptor's signature is the acceptance, so a transfer it
 * refused is not valid Bitcoin.
 */

export type KeySet = { threshold: number; keys: string[] }
export type CountersignKeySets = { issuer: KeySet; successor: KeySet }

/** The holder signs its input and every output: ALL | ANYONECANPAY | FORKID. */
export const HOLDER_SCOPE =
  TransactionSignature.SIGHASH_ALL |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID
/** An acceptor signs everything: ALL | FORKID. */
export const COUNTERSIGN_SCOPE =
  TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

const MAX_SET = 5
const KEY_RE = /^0[23][0-9a-f]{64}$/

export type CountersignBranch = 'issuer' | 'successor'

export function keySetsError(sets: CountersignKeySets): string | null {
  for (const [name, set] of [['issuer', sets.issuer], ['successor', sets.successor]] as const) {
    const n = set.keys.length
    if (!Number.isInteger(set.threshold) || set.threshold < 1 || set.threshold > n || n > MAX_SET) {
      return `${name} set must be m-of-n with 1 ≤ m ≤ n ≤ ${MAX_SET}`
    }
    if (!set.keys.every((key) => KEY_RE.test(key))) return `${name} keys must be compressed public keys`
    if (new Set(set.keys).size !== n) return `${name} set repeats a key`
  }
  if (sets.successor.keys.some((key) => sets.issuer.keys.includes(key))) {
    return 'a successor key may not also be an issuer key'
  }
  return null
}

function writeSmallInt(script: Script, n: number): void {
  script.writeOpCode(OP.OP_1 + n - 1)
}

function writeMultisig(script: Script, set: KeySet): void {
  writeSmallInt(script, set.threshold)
  for (const key of set.keys) script.writeBin(Utils.toArray(key, 'hex'))
  writeSmallInt(script, set.keys.length)
  script.writeOpCode(OP.OP_CHECKMULTISIG)
}

export function pubkeyHashHex(publicKeyHex: string): string {
  return Utils.toHex(Hash.hash160(Utils.toArray(publicKeyHex, 'hex')))
}

/** Holder AND (issuer m-of-n OR successor k-of-j). */
export function countersignClause(holderPkhHex: string, sets: CountersignKeySets): Script {
  const error = keySetsError(sets)
  if (error) throw new Error(error)
  if (!/^[0-9a-f]{40}$/.test(holderPkhHex)) throw new Error('Holder pubkey hash must be 20 bytes')
  const script = new Script()
  script
    .writeOpCode(OP.OP_DUP)
    .writeOpCode(OP.OP_HASH160)
    .writeBin(Utils.toArray(holderPkhHex, 'hex'))
    .writeOpCode(OP.OP_EQUALVERIFY)
    .writeOpCode(OP.OP_CHECKSIGVERIFY)
    .writeOpCode(OP.OP_IF)
  writeMultisig(script, sets.issuer)
  script.writeOpCode(OP.OP_ELSE)
  writeMultisig(script, sets.successor)
  script.writeOpCode(OP.OP_ENDIF)
  return script
}

/** A held output of an asset: `<asset id> <amount> OP_2DROP <clause>`. */
export function countersignedLock(args: {
  assetId: string
  amount: bigint
  holderPkhHex: string
  sets: CountersignKeySets
}): LockingScript {
  if (args.amount <= 0n) throw new Error('A countersigned output carries a positive amount')
  return encodeBsv21Binary({
    tokenId: args.assetId,
    amount: args.amount,
    rest: countersignClause(args.holderPkhHex, args.sets),
  })
}

/** Deploy output 0: `OP_0 <supply> OP_2DROP <payload> OP_DROP <clause>`. */
export function countersignDeployLock(args: {
  supply: bigint
  payload: number[]
  holderPkhHex: string
  sets: CountersignKeySets
}): LockingScript {
  if (args.supply <= 0n) throw new Error('Supply must be positive')
  if (args.payload.length === 0) throw new Error('A countersigned deploy needs its payload')
  const script = new LockingScript()
  script.writeOpCode(OP.OP_0)
  const amount = encodeScriptNumber(args.supply)
  if (amount.data) script.writeBin(amount.data)
  else script.writeOpCode(amount.op)
  script.writeOpCode(OP.OP_2DROP).writeBin(args.payload).writeOpCode(OP.OP_DROP)
  script.writeScript(countersignClause(args.holderPkhHex, args.sets))
  return script
}

/** The beacon the issuer re-spends to show it is alive: `OP_m <issuer keys> OP_n OP_CHECKMULTISIG`. */
export function beaconLock(issuer: KeySet): LockingScript {
  const script = new LockingScript()
  writeMultisig(script, issuer)
  return script
}

/** An item's content, fixed by its asset id: `OP_FALSE OP_RETURN <content>`. */
export function contentLock(bytes: number[]): LockingScript {
  return new LockingScript().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN).writeBin(bytes)
}

function smallIntOf(chunk: ScriptChunk | undefined): number | null {
  if (!chunk || chunk.data?.length) return null
  return chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16 ? chunk.op - OP.OP_1 + 1 : null
}

function readMultisig(chunks: ScriptChunk[], at: number): { set: KeySet; next: number } | null {
  const threshold = smallIntOf(chunks[at])
  if (threshold == null) return null
  const keys: string[] = []
  let i = at + 1
  while (chunks[i]?.data?.length === 33) {
    keys.push(Utils.toHex(chunks[i]!.data!))
    i += 1
  }
  if (smallIntOf(chunks[i]) !== keys.length || chunks[i + 1]?.op !== OP.OP_CHECKMULTISIG) return null
  return { set: { threshold, keys }, next: i + 2 }
}

/** Parse a clause exactly; anything else is not a countersign clause. */
export function readCountersignClause(
  scriptHex: string,
): { holderPkhHex: string; sets: CountersignKeySets } | null {
  let chunks: ScriptChunk[]
  try {
    chunks = Script.fromHex(scriptHex).chunks
  } catch {
    return null
  }
  if (
    chunks[0]?.op !== OP.OP_DUP ||
    chunks[1]?.op !== OP.OP_HASH160 ||
    chunks[2]?.data?.length !== 20 ||
    chunks[3]?.op !== OP.OP_EQUALVERIFY ||
    chunks[4]?.op !== OP.OP_CHECKSIGVERIFY ||
    chunks[5]?.op !== OP.OP_IF
  ) {
    return null
  }
  const issuer = readMultisig(chunks, 6)
  if (!issuer || chunks[issuer.next]?.op !== OP.OP_ELSE) return null
  const successor = readMultisig(chunks, issuer.next + 1)
  if (!successor || chunks[successor.next]?.op !== OP.OP_ENDIF || chunks.length !== successor.next + 1) {
    return null
  }
  const sets = { issuer: issuer.set, successor: successor.set }
  if (keySetsError(sets)) return null
  const holderPkhHex = Utils.toHex(chunks[2]!.data!)
  // Round-trip: only the canonical encoding counts.
  if (countersignClause(holderPkhHex, sets).toHex() !== scriptHex.toLowerCase()) return null
  return { holderPkhHex, sets }
}

export type CountersignedOutput = {
  /** Asset id (`txid_vout`); null on a deploy, whose id is its own outpoint. */
  assetId: string | null
  amount: bigint
  holderPkhHex: string
  sets: CountersignKeySets
  /** Deploy payload bytes. */
  payload?: Uint8Array
}

export function readCountersigned(script: Script | string): CountersignedOutput | null {
  const hex = typeof script === 'string' ? script.trim().toLowerCase() : script.toHex()
  const decoded = decodeBsv21Binary(hex)
  if (!decoded || decoded.layout !== 'brc162' || decoded.amount <= 0n) return null
  const clause = readCountersignClause(decoded.restScriptHex)
  if (!clause) return null
  let payload: Uint8Array | undefined
  if (!decoded.tokenId) {
    const chunks = Script.fromHex(hex).chunks
    if (chunks[4]?.op !== OP.OP_DROP || !chunks[3]?.data?.length) return null
    payload = Uint8Array.from(chunks[3].data)
  }
  return {
    assetId: decoded.tokenId ?? null,
    amount: decoded.amount,
    holderPkhHex: clause.holderPkhHex,
    sets: clause.sets,
    ...(payload ? { payload } : {}),
  }
}

export function sameKeySets(a: CountersignKeySets, b: CountersignKeySets): boolean {
  const same = (x: KeySet, y: KeySet) =>
    x.threshold === y.threshold && x.keys.length === y.keys.length && x.keys.every((k, i) => k === y.keys[i])
  return same(a.issuer, b.issuer) && same(a.successor, b.successor)
}

export function sourceOutputOf(
  tx: Transaction,
  vin: number,
): { satoshis: number; lockingScript: LockingScript } | null {
  const input = tx.inputs[vin]
  const out = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (!out?.lockingScript || typeof out.satoshis !== 'number') return null
  return { satoshis: out.satoshis, lockingScript: out.lockingScript }
}

export function sourceTxidOf(tx: Transaction, vin: number): string {
  const input = tx.inputs[vin]!
  return String(input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '').toLowerCase()
}

function sighashPreimage(tx: Transaction, vin: number, scope: number): number[] {
  const input = tx.inputs[vin]
  const source = sourceOutputOf(tx, vin)
  if (!input || !source) throw new Error(`Input ${vin} has no source output`)
  return TransactionSignature.format({
    sourceTXID: sourceTxidOf(tx, vin),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== vin),
    inputIndex: vin,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope,
  })
}

/** Checksig-format signature (DER ‖ sighash byte) over input `vin`. */
export function signInput(tx: Transaction, vin: number, key: PrivateKey, scope: number): number[] {
  const signature = key.sign(Hash.sha256(sighashPreimage(tx, vin, scope)))
  return new TransactionSignature(signature.r, signature.s, scope).toChecksigFormat()
}

export function holderUnlock(signature: number[], publicKeyHex: string): UnlockingScript {
  return new UnlockingScript().writeBin(signature).writeBin(Utils.toArray(publicKeyHex, 'hex'))
}

/** `OP_0 <countersignatures> <branch> <holder signature> <holder pubkey>`. */
export function countersignedUnlock(args: {
  countersignatures: number[][]
  branch: CountersignBranch
  holderSignature: number[]
  holderPublicKey: number[]
}): UnlockingScript {
  const script = new UnlockingScript().writeOpCode(OP.OP_0)
  for (const signature of args.countersignatures) script.writeBin(signature)
  script.writeOpCode(args.branch === 'issuer' ? OP.OP_1 : OP.OP_0)
  return script.writeBin(args.holderSignature).writeBin(args.holderPublicKey)
}

/** The holder's half of an unlocking script before acceptance: `<sig> <pubkey>`. */
export function readHolderUnlock(
  unlocking: UnlockingScript | undefined,
): { signature: number[]; publicKey: number[] } | null {
  const chunks = unlocking?.chunks ?? []
  if (chunks.length !== 2) return null
  const [signature, publicKey] = chunks
  if (!signature?.data?.length || publicKey?.data?.length !== 33) return null
  return { signature: signature.data, publicKey: publicKey.data }
}

/** A holder signature that is ALL|ANYONECANPAY, from the key the clause names. */
export function holderSignatureValid(tx: Transaction, vin: number, holderPkhHex: string): boolean {
  const holder = readHolderUnlock(tx.inputs[vin]?.unlockingScript)
  if (!holder) return false
  if (holder.signature[holder.signature.length - 1] !== HOLDER_SCOPE) return false
  const publicKeyHex = Utils.toHex(holder.publicKey)
  if (pubkeyHashHex(publicKeyHex) !== holderPkhHex) return false
  try {
    const signature = TransactionSignature.fromChecksigFormat(holder.signature)
    return PublicKey.fromString(publicKeyHex).verify(
      Hash.sha256(sighashPreimage(tx, vin, HOLDER_SCOPE)),
      signature,
    )
  } catch {
    return false
  }
}

/** Script-check input `vin` against the source output its EF claims. */
export function inputScriptValid(tx: Transaction, vin: number): boolean {
  const input = tx.inputs[vin]
  const source = sourceOutputOf(tx, vin)
  if (!input?.unlockingScript || !source) return false
  try {
    return new Spend({
      sourceTXID: sourceTxidOf(tx, vin),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== vin),
      outputs: tx.outputs,
      inputIndex: vin,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    return false
  }
}

/** Lowercase hex SHA-256 of the Extended Format bytes. */
export function requestIdOf(efBytes: number[]): string {
  return Utils.toHex(Hash.sha256(efBytes))
}
