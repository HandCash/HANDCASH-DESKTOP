import { Hash, LockingScript, OP, Script, TransactionSignature, UnlockingScript, Utils, type ScriptChunk } from '@bsv/sdk'
import { decodeScriptNumber, encodeScriptNumber } from '../token/decode162'

/**
 * BRC-255 (HCT) scripts. Every form is parsed exactly and re-encoded: only
 * the canonical encoding is an HCT output, so two readers never disagree on
 * which bytes carry an asset.
 *
 *   deploy:     <"hct">            <supply> <payload> OP_2DROP OP_DROP <clause>
 *   held:       <"hct" ‖ asset id> <amount> OP_2DROP <clause>
 *   authority:  <"hct" ‖ asset id> OP_0     OP_2DROP <clause>
 */

export const HCT_MARKER = [0x68, 0x63, 0x74] as const
const MARKER_HEX = '686374'
const KEY_RE = /^0[23][0-9a-f]{64}$/
const HASH20_RE = /^[0-9a-f]{40}$/
const MAX_SET = 5
export const HCT_MAX_AMOUNT = (1n << 64n) - 1n

/** The holder signs its input and every output: ALL | ANYONECANPAY | FORKID. */
export const HCT_HOLDER_SCOPE =
  TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID
/** A seller signs its input and the payment at its own index: SINGLE | ANYONECANPAY | FORKID. */
export const HCT_SALE_SCOPE =
  TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID
/** Issuers, acceptors and fee coins sign everything: ALL | FORKID. */
export const HCT_ISSUER_SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export type HctMode = 'open' | 'countersign'
/** Issuer keys as they appear in a clause (already derived, §3), with threshold `m`. */
export type HctIssuerSet = { m: number; keys: string[] }
export type HctRelease = { kind: 'hash'; rel: string } | { kind: 'keys'; k: number; keys: string[] }
/** Everything a clause fixes except the holder: closure compares these. */
export type HctRules = { mode: 'open' } | { mode: 'countersign'; issuer: HctIssuerSet; release: HctRelease }
export type HctClause = HctRules & { holder: string }

export type HctOutput =
  | { form: 'deploy'; supply: bigint; payload: Uint8Array; clause: HctClause }
  | { form: 'held'; assetId: string; amount: bigint; clause: HctClause }
  | { form: 'authority'; assetId: string; clause: HctClause }

export type HctBranch = 'issuer' | 'release'

/** `HASH160(txid in internal byte order ‖ index byte)`, 40 lowercase hex. */
export function hctAssetId(txid: string, index: number): string {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('A deploy txid is 32 bytes of hex')
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error('A deploy output index is 0 to 255')
  const internal = Utils.toArray(id, 'hex').reverse()
  return Utils.toHex(Hash.hash160([...internal, index]))
}

export function isHctAssetId(value: unknown): value is string {
  return typeof value === 'string' && HASH20_RE.test(value)
}

function setError(set: { m: number; keys: string[] }, name: string, oddMajority: boolean): string | null {
  const n = set.keys.length
  if (!Number.isInteger(set.m) || set.m < 1 || set.m > n || n > MAX_SET) return `${name} must be m-of-n with 1 ≤ m ≤ n ≤ ${MAX_SET}`
  if (oddMajority && n > 1 && 2 * set.m <= n) return `${name} needs more than half of its keys (2m > n)`
  if (!set.keys.every((k) => KEY_RE.test(k))) return `${name} keys must be compressed public keys`
  if (new Set(set.keys).size !== n) return `${name} repeats a key`
  return null
}

export function hctRulesError(rules: HctRules): string | null {
  if (rules.mode === 'open') return null
  const issuer = setError(rules.issuer, 'The issuer set', true)
  if (issuer) return issuer
  if (rules.release.kind === 'hash') return HASH20_RE.test(rules.release.rel) ? null : 'rel must be 20 bytes'
  const release = setError({ m: rules.release.k, keys: rules.release.keys }, 'The release set', false)
  if (release) return release
  if (rules.release.keys.some((k) => rules.issuer.keys.includes(k))) return 'A release key may not also be an issuer key'
  return null
}

function writeSmallInt(script: Script, n: number): void {
  script.writeOpCode(OP.OP_1 + n - 1)
}

function writeChecksigOrMultisig(script: Script, m: number, keys: string[]): void {
  if (keys.length === 1 && m === 1) {
    script.writeBin(Utils.toArray(keys[0]!, 'hex')).writeOpCode(OP.OP_CHECKSIG)
    return
  }
  writeSmallInt(script, m)
  for (const key of keys) script.writeBin(Utils.toArray(key, 'hex'))
  writeSmallInt(script, keys.length)
  script.writeOpCode(OP.OP_CHECKMULTISIG)
}

function writeIssuerPart(script: Script, issuer: HctIssuerSet): void {
  writeChecksigOrMultisig(script, issuer.m, issuer.keys)
}

function writeReleasePart(script: Script, release: HctRelease): void {
  if (release.kind === 'hash') {
    script.writeOpCode(OP.OP_HASH160).writeBin(Utils.toArray(release.rel, 'hex')).writeOpCode(OP.OP_EQUAL)
    return
  }
  // A key-set release is always OP_CHECKMULTISIG, so its unlock shape never depends on k.
  writeSmallInt(script, release.k)
  for (const key of release.keys) script.writeBin(Utils.toArray(key, 'hex'))
  writeSmallInt(script, release.keys.length)
  script.writeOpCode(OP.OP_CHECKMULTISIG)
}

/** The clause after the prefix: open `<holder> OP_CHECKSIG`, or the countersigned branch clause. */
export function hctClause(clause: HctClause): Script {
  const error = hctRulesError(clause)
  if (error) throw new Error(error)
  if (!KEY_RE.test(clause.holder)) throw new Error('The holder is a compressed public key')
  const script = new Script()
  script.writeBin(Utils.toArray(clause.holder, 'hex'))
  if (clause.mode === 'open') return script.writeOpCode(OP.OP_CHECKSIG)
  script.writeOpCode(OP.OP_CHECKSIGVERIFY).writeOpCode(OP.OP_IF)
  writeIssuerPart(script, clause.issuer)
  script.writeOpCode(OP.OP_ELSE)
  writeReleasePart(script, clause.release)
  return script.writeOpCode(OP.OP_ENDIF)
}

function writeAmount(script: Script, amount: bigint): void {
  const encoded = encodeScriptNumber(amount)
  if (encoded.data) script.writeBin(encoded.data)
  else script.writeOpCode(encoded.op)
}

export function hctDeployLock(args: { supply: bigint; payload: number[] | Uint8Array; clause: HctClause }): LockingScript {
  if (args.supply <= 0n || args.supply > HCT_MAX_AMOUNT) throw new Error('Supply is 1 to 2^64-1')
  if (args.payload.length === 0) throw new Error('A deploy carries its payload')
  const script = new LockingScript().writeBin([...HCT_MARKER])
  writeAmount(script, args.supply)
  script.writeBin([...args.payload]).writeOpCode(OP.OP_2DROP).writeOpCode(OP.OP_DROP)
  return script.writeScript(hctClause(args.clause))
}

export function hctHeldLock(args: { assetId: string; amount: bigint; clause: HctClause }): LockingScript {
  if (!isHctAssetId(args.assetId)) throw new Error('An asset id is 20 bytes of hex')
  if (args.amount <= 0n || args.amount > HCT_MAX_AMOUNT) throw new Error('A held output carries 1 to 2^64-1 units')
  const script = new LockingScript().writeBin([...HCT_MARKER, ...Utils.toArray(args.assetId, 'hex')])
  writeAmount(script, args.amount)
  return script.writeOpCode(OP.OP_2DROP).writeScript(hctClause(args.clause))
}

export function hctAuthorityLock(args: { assetId: string; clause: HctClause }): LockingScript {
  if (!isHctAssetId(args.assetId)) throw new Error('An asset id is 20 bytes of hex')
  return new LockingScript()
    .writeBin([...HCT_MARKER, ...Utils.toArray(args.assetId, 'hex')])
    .writeOpCode(OP.OP_0)
    .writeOpCode(OP.OP_2DROP)
    .writeScript(hctClause(args.clause))
}

/** The beacon (countersigned mode): `OP_IF <issuer part> OP_ELSE <release part> OP_ENDIF`. */
export function hctBeaconLock(rules: Extract<HctRules, { mode: 'countersign' }>): LockingScript {
  const error = hctRulesError(rules)
  if (error) throw new Error(error)
  const script = new LockingScript().writeOpCode(OP.OP_IF)
  writeIssuerPart(script, rules.issuer)
  script.writeOpCode(OP.OP_ELSE)
  writeReleasePart(script, rules.release)
  return script.writeOpCode(OP.OP_ENDIF)
}

/** `<key> OP_CHECKSIG`: issuer and fee coins. */
export function p2pkLock(publicKeyHex: string): LockingScript {
  if (!KEY_RE.test(publicKeyHex)) throw new Error('A P2PK key is a compressed public key')
  return new LockingScript().writeBin(Utils.toArray(publicKeyHex, 'hex')).writeOpCode(OP.OP_CHECKSIG)
}

/** `OP_m <keys> OP_n OP_CHECKMULTISIG`: a shared issuer set's deploy coin. */
export function multisigLock(m: number, keys: string[]): LockingScript {
  const error = setError({ m, keys }, 'The issuer set', true)
  if (error) throw new Error(error)
  const script = new LockingScript()
  writeSmallInt(script, m)
  for (const key of keys) script.writeBin(Utils.toArray(key, 'hex'))
  writeSmallInt(script, keys.length)
  return script.writeOpCode(OP.OP_CHECKMULTISIG) as LockingScript
}

function smallIntOf(chunk: ScriptChunk | undefined): number | null {
  if (!chunk || chunk.data?.length) return null
  return chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16 ? chunk.op - OP.OP_1 + 1 : null
}

function readKeys(chunks: ScriptChunk[], at: number): { keys: string[]; next: number } {
  const keys: string[] = []
  let i = at
  while (chunks[i]?.data?.length === 33) {
    keys.push(Utils.toHex(chunks[i]!.data!))
    i += 1
  }
  return { keys, next: i }
}

/** `<key> OP_CHECKSIG` or `OP_m <keys> OP_n OP_CHECKMULTISIG` at `at`. */
function readSigPart(chunks: ScriptChunk[], at: number): { m: number; keys: string[]; next: number } | null {
  if (chunks[at]?.data?.length === 33 && chunks[at + 1]?.op === OP.OP_CHECKSIG) {
    return { m: 1, keys: [Utils.toHex(chunks[at]!.data!)], next: at + 2 }
  }
  const m = smallIntOf(chunks[at])
  if (m == null) return null
  const { keys, next } = readKeys(chunks, at + 1)
  if (smallIntOf(chunks[next]) !== keys.length || chunks[next + 1]?.op !== OP.OP_CHECKMULTISIG) return null
  return { m, keys, next: next + 2 }
}

function readReleasePart(chunks: ScriptChunk[], at: number): { release: HctRelease; next: number } | null {
  if (chunks[at]?.op === OP.OP_HASH160 && chunks[at + 1]?.data?.length === 20 && chunks[at + 2]?.op === OP.OP_EQUAL) {
    return { release: { kind: 'hash', rel: Utils.toHex(chunks[at + 1]!.data!) }, next: at + 3 }
  }
  const k = smallIntOf(chunks[at])
  if (k == null) return null
  const { keys, next } = readKeys(chunks, at + 1)
  if (smallIntOf(chunks[next]) !== keys.length || chunks[next + 1]?.op !== OP.OP_CHECKMULTISIG) return null
  return { release: { kind: 'keys', k, keys }, next: next + 2 }
}

/** Parse a clause from `chunks[at…]` to the end; `readHct` then requires the whole script to re-encode. */
function readClauseChunks(chunks: ScriptChunk[], at: number): HctClause | null {
  const holder = chunks[at]?.data?.length === 33 ? Utils.toHex(chunks[at]!.data!) : null
  if (!holder || !KEY_RE.test(holder)) return null
  let clause: HctClause
  if (chunks[at + 1]?.op === OP.OP_CHECKSIG && chunks.length === at + 2) {
    clause = { mode: 'open', holder }
  } else {
    if (chunks[at + 1]?.op !== OP.OP_CHECKSIGVERIFY || chunks[at + 2]?.op !== OP.OP_IF) return null
    const issuer = readSigPart(chunks, at + 3)
    if (!issuer || chunks[issuer.next]?.op !== OP.OP_ELSE) return null
    const release = readReleasePart(chunks, issuer.next + 1)
    if (!release || chunks[release.next]?.op !== OP.OP_ENDIF || chunks.length !== release.next + 1) return null
    clause = { mode: 'countersign', holder, issuer: { m: issuer.m, keys: issuer.keys }, release: release.release }
  }
  return hctRulesError(clause) ? null : clause
}

function chunksOf(script: Script | string): { chunks: ScriptChunk[]; hex: string } | null {
  try {
    const hex = typeof script === 'string' ? script.trim().toLowerCase() : script.toHex()
    if (!hex.startsWith(`03${MARKER_HEX}`) && !hex.startsWith(`17${MARKER_HEX}`)) return null
    return { chunks: Script.fromHex(hex).chunks, hex }
  } catch {
    return null
  }
}

/** Read any HCT output form; null for anything not canonical HCT. */
export function readHct(script: Script | string): HctOutput | null {
  const parsed = chunksOf(script)
  if (!parsed) return null
  const { chunks, hex } = parsed
  const head = chunks[0]?.data
  if (!head || (head.length !== 3 && head.length !== 23) || Utils.toHex(head.slice(0, 3)) !== MARKER_HEX) return null
  let out: HctOutput
  if (head.length === 3) {
    const supply = chunks[1] ? decodeScriptNumber(chunks[1]) : null
    const payload = chunks[2]?.data
    if (supply == null || supply <= 0n || !payload?.length) return null
    if (chunks[3]?.op !== OP.OP_2DROP || chunks[4]?.op !== OP.OP_DROP) return null
    const clause = readClauseChunks(chunks, 5)
    if (!clause) return null
    out = { form: 'deploy', supply, payload: Uint8Array.from(payload), clause }
  } else {
    const assetId = Utils.toHex(head.slice(3))
    const amount = chunks[1] ? decodeScriptNumber(chunks[1]) : null
    if (amount == null || chunks[2]?.op !== OP.OP_2DROP) return null
    const clause = readClauseChunks(chunks, 3)
    if (!clause) return null
    out = amount === 0n ? { form: 'authority', assetId, clause } : { form: 'held', assetId, amount, clause }
  }
  try {
    const reencoded =
      out.form === 'deploy'
        ? hctDeployLock({ supply: out.supply, payload: out.payload, clause: out.clause })
        : out.form === 'held'
          ? hctHeldLock({ assetId: out.assetId, amount: out.amount, clause: out.clause })
          : hctAuthorityLock({ assetId: out.assetId, clause: out.clause })
    return reencoded.toHex() === hex ? out : null
  } catch {
    return null
  }
}

/** True when the first push is the HCT marker or the marker plus an asset id: never BRC-162. */
export function looksLikeHct(script: Script | string): boolean {
  return chunksOf(script) != null
}

export function rulesOf(clause: HctClause): HctRules {
  if (clause.mode === 'open') return { mode: 'open' }
  return { mode: 'countersign', issuer: clause.issuer, release: clause.release }
}

export function sameRules(a: HctRules, b: HctRules): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'open' || b.mode === 'open') return true
  const sameSet = (x: { m: number; keys: string[] }, y: { m: number; keys: string[] }) =>
    x.m === y.m && x.keys.length === y.keys.length && x.keys.every((k, i) => k === y.keys[i])
  if (!sameSet(a.issuer, b.issuer)) return false
  if (a.release.kind !== b.release.kind) return false
  if (a.release.kind === 'hash' && b.release.kind === 'hash') return a.release.rel === b.release.rel
  if (a.release.kind === 'keys' && b.release.kind === 'keys') {
    return sameSet({ m: a.release.k, keys: a.release.keys }, { m: b.release.k, keys: b.release.keys })
  }
  return false
}

// ── Unlocking scripts ──────────────────────────────────────────────────────

export function hctOpenUnlock(holderSignature: number[]): UnlockingScript {
  return new UnlockingScript().writeBin(holderSignature)
}

/** `<issuer sig> OP_1 <holder sig>`, or `OP_0 <sig 1> … <sig m> OP_1 <holder sig>` for a shared set. */
export function hctIssuerUnlock(args: { issuerSignatures: number[][]; shared: boolean; holderSignature: number[] }): UnlockingScript {
  const script = new UnlockingScript()
  if (args.shared) script.writeOpCode(OP.OP_0)
  for (const signature of args.issuerSignatures) script.writeBin(signature)
  return script.writeOpCode(OP.OP_1).writeBin(args.holderSignature)
}

/** `<release secret> OP_0 <holder sig>`. */
export function hctReleaseUnlock(secret: number[], holderSignature: number[]): UnlockingScript {
  if (secret.length !== 32) throw new Error('A release secret is 32 bytes')
  return new UnlockingScript().writeBin(secret).writeOpCode(OP.OP_0).writeBin(holderSignature)
}

/** `OP_0 <release sig 1> … <release sig k> OP_0 <holder sig>`. */
export function hctKeyReleaseUnlock(releaseSignatures: number[][], holderSignature: number[]): UnlockingScript {
  const script = new UnlockingScript().writeOpCode(OP.OP_0)
  for (const signature of releaseSignatures) script.writeBin(signature)
  return script.writeOpCode(OP.OP_0).writeBin(holderSignature)
}

/** The branch a countersigned unlock took, from its second-to-last chunk; null for any other shape. */
export function hctUnlockBranch(unlocking: UnlockingScript | undefined): HctBranch | null {
  const chunks = unlocking?.chunks ?? []
  if (chunks.length < 3) return null
  const branch = chunks[chunks.length - 2]
  const holder = chunks[chunks.length - 1]
  if (!holder?.data?.length || branch?.data?.length) return null
  return branch?.op === OP.OP_1 ? 'issuer' : branch?.op === OP.OP_0 ? 'release' : null
}

/** The release secret a hash-lock release-branch unlock reveals. */
export function revealedSecret(unlocking: UnlockingScript | undefined): number[] | null {
  const chunks = unlocking?.chunks ?? []
  if (chunks.length !== 3 || hctUnlockBranch(unlocking) !== 'release') return null
  const secret = chunks[0]?.data
  return secret?.length === 32 ? [...secret] : null
}

export function hash160Hex(bytes: number[]): string {
  return Utils.toHex(Hash.hash160(bytes))
}
