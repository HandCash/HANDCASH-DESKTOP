import { Hash, OP, Script, TransactionSignature, UnlockingScript, Utils, type ScriptChunk, type Transaction } from '@bsv/sdk'
import { decodeScriptNumber, encodeScriptNumber } from '../scriptNumber'
import { sighashPreimage } from '../txInputs'

/**
 * The open-mint covenant (BRC-255 §5a). It follows the mint output's prefix
 * `<"bnt" ‖ asset id> OP_0 <remaining, 4 bytes LE> OP_2DROP OP_DROP` and lets
 * anyone spend that output, but only in a transaction whose outputs begin
 *
 *   0: the same mint output with `remaining − 1` (left out once it reaches 0)
 *   next: `<"bnt" ‖ asset id> <lim> OP_2DROP <holder> OP_CHECKSIG`, one satoshi
 *
 * The unlock is `<later outputs> <holder> <sighash preimage>`. The script
 * proves the preimage is this transaction's by building an ECDSA signature
 * over it with private key 1 and nonce 1 (OP_PUSH_TX) and checking it against
 * the generator, then reads its own script and hashOutputs from it.
 */

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const GX_BYTES = Utils.toArray(GX.toString(16).padStart(64, '0'), 'hex')
const G_PUB = [0x02, ...GX_BYTES]
/** The covenant's own signature covers every input and output. */
export const BNT_MINT_SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
const ONE_SAT = [1, 0, 0, 0, 0, 0, 0, 0]
const SCRIPT_CODE_OFFSET = 104
const PREIMAGE_TAIL = 52
const PREFIX_BYTES = 26
const ASSET_PREFIX_BYTES = 24

/** Minimal script number of a non-negative bigint of any size. */
function scriptNum(n: bigint): number[] {
  const bytes: number[] = []
  for (let v = n; v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn))
  if (bytes.length && (bytes[bytes.length - 1]! & 0x80) !== 0) bytes.push(0)
  return bytes
}

function pushInt(script: Script, n: number): void {
  const encoded = encodeScriptNumber(BigInt(n))
  if (encoded.data) script.writeBin(encoded.data)
  else script.writeOpCode(encoded.op)
}

function ops(script: Script, ...codes: number[]): void {
  for (const code of codes) script.writeOpCode(code)
}

/** Reverse the 32-byte top item. */
function reverse32(script: Script): void {
  for (let i = 0; i < 31; i++) ops(script, OP.OP_1, OP.OP_SPLIT)
  for (let i = 0; i < 31; i++) ops(script, OP.OP_SWAP, OP.OP_CAT)
}

/** The canonical push of `lim` followed by `OP_2DROP` and the 33-byte push opcode of a held output. */
function heldMiddle(lim: bigint): number[] {
  const encoded = encodeScriptNumber(lim)
  return [...(encoded.data ? [encoded.op, ...encoded.data] : [encoded.op]), OP.OP_2DROP, 33]
}

/** The covenant after the mint prefix, `OP_2DROP OP_DROP` included. */
export function mintCovenantBody(lim: bigint): Script {
  if (lim < 1n) throw new Error('A mint writes at least one unit')
  const middle = heldMiddle(lim)
  const heldLength = ASSET_PREFIX_BYTES + middle.length + 33 + 1
  const s = new Script()
  ops(s, OP.OP_2DROP, OP.OP_DROP)
  // The preimage is this transaction's: sign its hash with d = k = 1 and check against G.
  ops(s, OP.OP_DUP, OP.OP_HASH256)
  reverse32(s)
  s.writeBin([0])
  ops(s, OP.OP_CAT, OP.OP_BIN2NUM)
  s.writeBin(scriptNum(GX))
  s.writeOpCode(OP.OP_ADD)
  s.writeBin(scriptNum(N))
  s.writeOpCode(OP.OP_MOD)
  s.writeOpCode(OP.OP_DUP)
  s.writeBin(scriptNum(N / 2n))
  ops(s, OP.OP_GREATERTHAN, OP.OP_IF)
  s.writeBin(scriptNum(N))
  ops(s, OP.OP_SWAP, OP.OP_SUB, OP.OP_ENDIF)
  pushInt(s, 32)
  s.writeOpCode(OP.OP_NUM2BIN)
  reverse32(s)
  s.writeBin([0x30, 0x44, 0x02, 0x20, ...GX_BYTES, 0x02, 0x20])
  ops(s, OP.OP_SWAP, OP.OP_CAT)
  s.writeBin([BNT_MINT_SCOPE])
  s.writeOpCode(OP.OP_CAT)
  s.writeBin(G_PUB)
  s.writeOpCode(OP.OP_CHECKSIGVERIFY)
  // hashOutputs to the alt stack; this script's code, split around its 4-byte counter.
  pushInt(s, SCRIPT_CODE_OFFSET)
  ops(s, OP.OP_SPLIT, OP.OP_NIP, OP.OP_SIZE)
  pushInt(s, PREIMAGE_TAIL)
  ops(s, OP.OP_SUB, OP.OP_SPLIT)
  pushInt(s, 12)
  ops(s, OP.OP_SPLIT, OP.OP_NIP)
  pushInt(s, 32)
  ops(s, OP.OP_SPLIT, OP.OP_DROP, OP.OP_TOALTSTACK, OP.OP_3, OP.OP_SPLIT)
  pushInt(s, PREFIX_BYTES)
  ops(s, OP.OP_SPLIT, OP.OP_4, OP.OP_SPLIT, OP.OP_SWAP, OP.OP_BIN2NUM, OP.OP_1SUB)
  ops(s, OP.OP_DUP, OP.OP_0, OP.OP_GREATERTHANOREQUAL, OP.OP_VERIFY)
  // Output 0: this mint again with one fewer left, unless none are.
  ops(s, OP.OP_DUP, OP.OP_0NOTEQUAL, OP.OP_IF, OP.OP_4, OP.OP_NUM2BIN)
  ops(s, OP.OP_2, OP.OP_PICK, OP.OP_SWAP, OP.OP_CAT, OP.OP_SWAP, OP.OP_CAT, OP.OP_ROT, OP.OP_SWAP, OP.OP_CAT)
  s.writeBin(ONE_SAT)
  ops(s, OP.OP_SWAP, OP.OP_CAT, OP.OP_ELSE, OP.OP_2DROP, OP.OP_NIP, OP.OP_0, OP.OP_ENDIF)
  // Then `lim` units to the minter's key, one satoshi.
  ops(s, OP.OP_SWAP)
  pushInt(s, ASSET_PREFIX_BYTES)
  ops(s, OP.OP_SPLIT, OP.OP_DROP)
  s.writeBin([...ONE_SAT, heldLength])
  ops(s, OP.OP_SWAP, OP.OP_CAT)
  s.writeBin(middle)
  ops(s, OP.OP_CAT, OP.OP_ROT, OP.OP_SIZE)
  pushInt(s, 33)
  ops(s, OP.OP_EQUALVERIFY, OP.OP_DUP, OP.OP_1, OP.OP_SPLIT, OP.OP_DROP, OP.OP_DUP, OP.OP_2, OP.OP_EQUAL)
  ops(s, OP.OP_SWAP, OP.OP_3, OP.OP_EQUAL, OP.OP_BOOLOR, OP.OP_VERIFY, OP.OP_CAT)
  s.writeBin([OP.OP_CHECKSIG])
  // Every other output follows, as the minter wrote it.
  ops(s, OP.OP_CAT, OP.OP_CAT, OP.OP_SWAP, OP.OP_CAT, OP.OP_HASH256, OP.OP_FROMALTSTACK, OP.OP_EQUAL)
  return s
}

const LIM_CHUNK = mintCovenantBody(1n).chunks.findIndex((c) => c.data?.length === 3 && c.data[1] === OP.OP_2DROP && c.data[2] === 33)

/** The `lim` a covenant body (chunks after the counter) mints, or null; the caller compares the re-encoding. */
export function mintCovenantLim(body: ScriptChunk[]): bigint | null {
  const data = body[LIM_CHUNK]?.data
  if (!data || data.length < 3 || data[data.length - 2] !== OP.OP_2DROP || data[data.length - 1] !== 33) return null
  try {
    const chunk = Script.fromBinary(data.slice(0, -2)).chunks
    if (chunk.length !== 1) return null
    const lim = decodeScriptNumber(chunk[0]!)
    return lim != null && lim > 0n ? lim : null
  } catch {
    return null
  }
}

function varInt(n: number): number[] {
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8]
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

/** Outputs as hashOutputs serializes them. */
export function serializeOutputs(outputs: Transaction['outputs']): number[] {
  const out: number[] = []
  for (const o of outputs) {
    let sats = BigInt(o.satoshis ?? 0)
    for (let i = 0; i < 8; i++, sats >>= 8n) out.push(Number(sats & 0xffn))
    const script = o.lockingScript.toBinary()
    out.push(...varInt(script.length), ...script)
  }
  return out
}

/**
 * Whether the covenant can sign this preimage. Its `s` is written as 32 bytes,
 * so about 1 in 512 transactions would carry a non-canonical signature; the
 * builder changes the transaction and tries again.
 */
export function mintPreimageSigns(preimage: number[]): boolean {
  const z = BigInt(`0x${Utils.toHex(Hash.hash256(preimage))}`)
  let s = (z + GX) % N
  if (s > N / 2n) s = N - s
  const be = s.toString(16).padStart(64, '0')
  return !(be.startsWith('00') && parseInt(be.slice(2, 4), 16) < 0x80)
}

/**
 * The unlock of the mint output at input `vin`: the outputs after the ones the
 * covenant fixes, the minter's holder key and the preimage. Null when the
 * transaction needs another try (`mintPreimageSigns`).
 */
export function bntMintUnlock(tx: Transaction, vin: number, holder: string, remaining: number): UnlockingScript | null {
  if (!/^0[23][0-9a-f]{64}$/.test(holder)) throw new Error('The holder is a compressed public key')
  const preimage = sighashPreimage(tx, vin, BNT_MINT_SCOPE)
  if (!mintPreimageSigns(preimage)) return null
  const fixed = remaining > 1 ? 2 : 1
  return new UnlockingScript()
    .writeBin(serializeOutputs(tx.outputs.slice(fixed)))
    .writeBin(Utils.toArray(holder, 'hex'))
    .writeBin(preimage)
}

/** The holder key a mint unlock names, or null for any other shape. */
export function mintUnlockHolder(unlocking: UnlockingScript | undefined): string | null {
  const chunks = unlocking?.chunks ?? []
  const key = chunks.length === 3 ? chunks[1]?.data : undefined
  return key?.length === 33 ? Utils.toHex(key) : null
}
