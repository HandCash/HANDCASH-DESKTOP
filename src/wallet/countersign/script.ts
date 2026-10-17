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
import { decodeBsv21Binary, encodeBsv21Binary, encodeScriptNumber, tokenIdFromWire, tokenIdToWire } from '../token/decode162'

/**
 * Countersigned assets (unpublished issuer-control draft): a BRC-162 prefix
 * followed by a clause that needs the holder's signature and a quorum of
 * either the issuer set or the release set. The issuer's signature is the
 * acceptance, so a transfer it refused is not valid Bitcoin. The release set
 * signs nothing while the issuer is alive; once the beacon ends, its private
 * keys are published and the asset moves on its holder's signature alone.
 */

export type KeySet = { threshold: number; keys: string[] }
export type CountersignKeySets = { issuer: KeySet; release: KeySet }

/** The holder signs its input and every output: ALL | ANYONECANPAY | FORKID. */
export const HOLDER_SCOPE =
  TransactionSignature.SIGHASH_ALL |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID
/**
 * A holder that sells signs its input and only the output at its own index,
 * its payment: SINGLE | ANYONECANPAY | FORKID. The buyer completes the rest,
 * and the acceptor's ALL signature then fixes the whole transaction.
 */
export const SWAP_HOLDER_SCOPE =
  TransactionSignature.SIGHASH_SINGLE |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID
/** An acceptor signs everything: ALL | FORKID. */
export const COUNTERSIGN_SCOPE =
  TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

const MAX_SET = 5
const KEY_RE = /^0[23][0-9a-f]{64}$/

export type CountersignBranch = 'issuer' | 'release'

export function keySetsError(sets: CountersignKeySets): string | null {
  for (const [name, set] of [['issuer', sets.issuer], ['release', sets.release]] as const) {
    const n = set.keys.length
    if (!Number.isInteger(set.threshold) || set.threshold < 1 || set.threshold > n || n > MAX_SET) {
      return `${name} set must be m-of-n with 1 ≤ m ≤ n ≤ ${MAX_SET}`
    }
    if (!set.keys.every((key) => KEY_RE.test(key))) return `${name} keys must be compressed public keys`
    if (new Set(set.keys).size !== n) return `${name} set repeats a key`
  }
  if (sets.release.keys.some((key) => sets.issuer.keys.includes(key))) {
    return 'a release key may not also be an issuer key'
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

/** Holder AND (issuer m-of-n OR release k-of-j). */
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
  writeMultisig(script, sets.release)
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

/** The beacon: `OP_IF <issuer m-of-n> OP_ELSE <release k-of-j> OP_ENDIF`. */
export function beaconLock(sets: CountersignKeySets): LockingScript {
  const script = new LockingScript().writeOpCode(OP.OP_IF)
  writeMultisig(script, sets.issuer)
  script.writeOpCode(OP.OP_ELSE)
  writeMultisig(script, sets.release)
  return script.writeOpCode(OP.OP_ENDIF)
}

/** `OP_0 <signatures> <branch>`; signatures in key order, sighash ALL|FORKID. */
export function beaconUnlock(signatures: number[][], branch: CountersignBranch): UnlockingScript {
  const script = new UnlockingScript().writeOpCode(OP.OP_0)
  for (const signature of signatures) script.writeBin(signature)
  return script.writeOpCode(branch === 'issuer' ? OP.OP_1 : OP.OP_0)
}

const RETIRE_TAG = Utils.toArray('countersign retire', 'utf8')
const RELEASE_TAG = Utils.toArray('countersign release', 'utf8')

/** `OP_FALSE OP_RETURN "countersign retire" <asset id>`, beside the final beacon. */
export function retireMarkerLock(assetId: string): LockingScript {
  return new LockingScript()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(RETIRE_TAG)
    .writeBin([...tokenIdToWire(assetId)])
}

/** `OP_FALSE OP_RETURN "countersign release" <asset id> <private keys>`, 32-byte big-endian scalars. */
export function releaseDisclosureLock(assetId: string, keys: PrivateKey[]): LockingScript {
  const script = new LockingScript()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(RELEASE_TAG)
    .writeBin([...tokenIdToWire(assetId)])
  for (const key of keys) script.writeBin(key.toArray('be', 32))
  return script
}

export type BeaconMarker =
  | { kind: 'retire'; assetId: string }
  | { kind: 'release'; assetId: string; keys: string[] }

/** A retire or release marker; a parsed script folds everything after OP_RETURN into one chunk. */
export function readBeaconMarker(script: Script | string): BeaconMarker | null {
  let chunks: ScriptChunk[]
  try {
    const hex = typeof script === 'string' ? script : script.toHex()
    const top = Script.fromHex(hex).chunks
    if (top[0]?.op !== OP.OP_FALSE || top[1]?.op !== OP.OP_RETURN || !top[1].data?.length) return null
    chunks = Script.fromBinary(top[1].data).chunks
  } catch {
    return null
  }
  const tag = Utils.toHex(chunks[0]?.data ?? [])
  const assetId = chunks[1]?.data?.length === 36 ? tokenIdFromWire(chunks[1].data) : null
  if (!assetId) return null
  if (tag === Utils.toHex(RETIRE_TAG)) return chunks.length === 2 ? { kind: 'retire', assetId } : null
  if (tag !== Utils.toHex(RELEASE_TAG)) return null
  const keys = chunks.slice(2).map((c) => (c.data?.length === 32 ? Utils.toHex(c.data) : ''))
  return keys.length > 0 && keys.every(Boolean) ? { kind: 'release', assetId, keys } : null
}

/**
 * The disclosed keys of a release marker, in release-set order, when they are
 * at least `k` distinct keys of that set; anything else is no release.
 */
export function disclosedReleaseKeys(keysHex: string[], release: KeySet): PrivateKey[] | null {
  const byPub = new Map<string, PrivateKey>()
  for (const hex of keysHex) {
    let key: PrivateKey
    try {
      key = PrivateKey.fromHex(hex)
    } catch {
      return null
    }
    const pub = key.toPublicKey().toString()
    if (!release.keys.includes(pub) || byPub.has(pub)) return null
    byPub.set(pub, key)
  }
  if (byPub.size < release.threshold) return null
  return release.keys.flatMap((pub) => (byPub.has(pub) ? [byPub.get(pub)!] : [])).slice(0, release.threshold)
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
  const release = readMultisig(chunks, issuer.next + 1)
  if (!release || chunks[release.next]?.op !== OP.OP_ENDIF || chunks.length !== release.next + 1) {
    return null
  }
  const sets = { issuer: issuer.set, release: release.set }
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
  return same(a.issuer, b.issuer) && same(a.release, b.release)
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

/** A cosigner's ALL|FORKID countersignature over input `vin`, from `publicKeyHex`. */
export function countersignatureValid(
  tx: Transaction,
  vin: number,
  publicKeyHex: string,
  checksig: number[],
): boolean {
  if (checksig[checksig.length - 1] !== COUNTERSIGN_SCOPE) return false
  try {
    return PublicKey.fromString(publicKeyHex).verify(
      Hash.sha256(sighashPreimage(tx, vin, COUNTERSIGN_SCOPE)),
      TransactionSignature.fromChecksigFormat(checksig),
    )
  } catch {
    return false
  }
}

/** Countersignatures by key, in the issuer set's key order (OP_CHECKMULTISIG's order), the first `threshold`. */
export function quorumSignatures(set: KeySet, byKey: ReadonlyMap<string, number[]>): number[][] | null {
  const ordered = set.keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []))
  return ordered.length >= set.threshold ? ordered.slice(0, set.threshold) : null
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

/** The branch a countersigned unlock took, read from `… <branch> <holder sig> <holder pubkey>`. */
export function unlockBranch(unlocking: UnlockingScript | undefined): CountersignBranch | null {
  const chunks = unlocking?.chunks ?? []
  if (chunks.length < 4 || chunks[0]?.op !== OP.OP_0) return null
  const branch = chunks[chunks.length - 3]
  if (branch?.data?.length) return null
  return branch?.op === OP.OP_1 ? 'issuer' : branch?.op === OP.OP_0 ? 'release' : null
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

/** The sighash byte of input `vin`'s holder signature, or null without one. */
export function holderScopeOf(tx: Transaction, vin: number): number | null {
  const holder = readHolderUnlock(tx.inputs[vin]?.unlockingScript)
  return holder ? holder.signature[holder.signature.length - 1]! : null
}

/** A holder signature in one of `scopes` (ALL|ANYONECANPAY alone by default), from the key the clause names. */
export function holderSignatureValid(
  tx: Transaction,
  vin: number,
  holderPkhHex: string,
  scopes: readonly number[] = [HOLDER_SCOPE],
): boolean {
  const holder = readHolderUnlock(tx.inputs[vin]?.unlockingScript)
  if (!holder) return false
  const scope = holder.signature[holder.signature.length - 1]!
  if (!scopes.includes(scope)) return false
  const publicKeyHex = Utils.toHex(holder.publicKey)
  if (pubkeyHashHex(publicKeyHex) !== holderPkhHex) return false
  try {
    const signature = TransactionSignature.fromChecksigFormat(holder.signature)
    return PublicKey.fromString(publicKeyHex).verify(
      Hash.sha256(sighashPreimage(tx, vin, scope)),
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
