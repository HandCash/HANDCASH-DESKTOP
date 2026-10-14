import { Hash, OP, PublicKey, Script, Utils, type PrivateKey, type Transaction } from '@bsv/sdk'
import Sigma from '@1sat/templates/sigma'
import { Algorithm } from 'sigma-protocol'
import { expandedProtocolScript, normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'

/**
 * BRC-248 §5 link records: an identity key and a BAP identity both sign that
 * the BAP profile labels the identity key. The identity key signs first with
 * Sigma BRC-77; a BAP signing key then signs everything before it with Sigma
 * BSM. Both bind to one real input. Either party alone signs an unlink.
 */

const MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const TYPE = { link: 'identity-link', unlink: 'identity-unlink' } as const
/** Every link record carries the `identity-link` or `identity-unlink` push; skip parsing otherwise. */
const TYPE_MARKER_HEX = Utils.toHex(Utils.toArray('identity-', 'utf8'))

export type IdentityLinkKind = keyof typeof TYPE

/** A link or unlink whose signatures verified against the input they name. */
export type IdentityLinkRecord = {
  kind: IdentityLinkKind
  identityKey: string
  bapId: string
  /** The BAP signing address of the BSM signature; absent on an unlink the identity key signed. */
  bapSigner?: string
}

export type IdentityLinkSigner = { kind: 'identity'; key: PrivateKey } | { kind: 'bap'; key: PrivateKey }

function inputHash(txid: string, vout: number): number[] {
  return Hash.sha256([...Utils.toArray(txid, 'hex'), vout & 255, (vout >>> 8) & 255, (vout >>> 16) & 255, (vout >>> 24) & 255])
}

function appendSigma(script: Script, signer: PrivateKey, algorithm: Algorithm, anchor: { txid: string; vout: number }) {
  const sigma = Sigma.sign(inputHash(anchor.txid, anchor.vout), Hash.sha256(script.toBinary()), signer, {
    algorithm,
    vin: 0,
  })
  for (const field of ['|', 'SIGMA', sigma.data.algorithm, sigma.data.address]) script.writeBin(Utils.toArray(field, 'utf8'))
  script.writeBin(sigma.data.signature)
  script.writeBin(Utils.toArray('0', 'utf8'))
}

/**
 * The record script, bound to `anchor`, which the transaction MUST spend as
 * input 0. A link takes the identity key and a BAP signing key, in that order;
 * an unlink takes exactly one of them.
 */
export function identityLinkScript(args: {
  kind: IdentityLinkKind
  identityKey: string
  bapId: string
  signers: readonly IdentityLinkSigner[]
  anchor: { txid: string; vout: number }
}): string {
  const identityKey = normalizeIssuerIdentityKey(args.identityKey)
  const bapId = normalizeBapId(args.bapId)
  if (!identityKey || !bapId) throw new Error('Invalid identity link.')
  if (!/^[0-9a-f]{64}$/i.test(args.anchor.txid) || !Number.isSafeInteger(args.anchor.vout) || args.anchor.vout < 0)
    throw new Error('Invalid identity link anchor.')
  const shape = args.signers.map((signer) => signer.kind).join(',')
  if (args.kind === 'link' ? shape !== 'identity,bap' : shape !== 'identity' && shape !== 'bap')
    throw new Error('An identity link needs the identity key then a BAP key; an unlink needs one of them.')
  const identitySigner = args.signers.find((signer) => signer.kind === 'identity')
  if (identitySigner && identitySigner.key.toPublicKey().toString().toLowerCase() !== identityKey)
    throw new Error('The identity link is signed by another identity key.')
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  for (const field of [MAP, 'SET', 'type', TYPE[args.kind], 'identityKey', identityKey, 'bapId', bapId])
    script.writeBin(Utils.toArray(field, 'utf8'))
  for (const signer of args.signers)
    appendSigma(script, signer.key, signer.kind === 'identity' ? Algorithm.BRC77 : Algorithm.BSM, args.anchor)
  return script.toHex()
}

/** BRC-77 for anyone: version, signer key, `0x00` verifier, key ID, DER signature of at most 72 bytes. */
const BRC77_MAX_BYTES = 4 + 33 + 1 + 32 + 72
const BSM_BYTES = 65

/**
 * Largest script a link for these keys can be, so a plan sizes it before the
 * anchor exists and before its randomized BRC-77 signature is made.
 */
export function identityLinkScriptMaxBytes(identityKey: string, bapId: string, bapAddress: string): number {
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  for (const field of [MAP, 'SET', 'type', TYPE.link, 'identityKey', identityKey, 'bapId', bapId])
    script.writeBin(Utils.toArray(field, 'utf8'))
  const sigmas: Array<[Algorithm, string, number]> = [
    [Algorithm.BRC77, PublicKey.fromString(identityKey).toAddress(), BRC77_MAX_BYTES],
    [Algorithm.BSM, bapAddress, BSM_BYTES],
  ]
  for (const [algorithm, address, bytes] of sigmas) {
    for (const field of ['|', 'SIGMA', algorithm, address]) script.writeBin(Utils.toArray(field, 'utf8'))
    script.writeBin(new Array<number>(bytes).fill(1))
    script.writeBin(Utils.toArray('0', 'utf8'))
  }
  return script.toBinary().length
}

type Verified = { algorithm: Algorithm; address: string; vin: number; key?: string }

/** Each SIGMA after the MAP tape, verified over every chunk before its separator. */
function verifiedSigmas(tx: Transaction, chunks: Script['chunks'], separators: number[]): Verified[] | null {
  const out: Verified[] = []
  for (let n = 0; n < separators.length; n++) {
    const at = separators[n]!
    const end = separators[n + 1] ?? chunks.length
    const fields = chunks.slice(at + 1, end).map((chunk) => chunk.data ?? [])
    if (fields.length !== 5 || Utils.toUTF8(fields[0]!) !== 'SIGMA') return null
    const algorithm = Utils.toUTF8(fields[1]!) as Algorithm
    const address = Utils.toUTF8(fields[2]!)
    const signature = fields[3]!
    const vinText = Utils.toUTF8(fields[4]!)
    if (!/^\d{1,4}$/.test(vinText)) return null
    const vin = Number(vinText)
    const input = tx.inputs[vin]
    const txid = input?.sourceTXID ?? input?.sourceTransaction?.id('hex')
    if (!input || !txid || !/^[0-9a-f]{64}$/i.test(txid)) return null
    let key: string | undefined
    if (algorithm === Algorithm.BRC77) {
      if (signature.length < 37) return null
      key = Utils.toHex(signature.slice(4, 37)).toLowerCase()
      if (PublicKey.fromString(key).toAddress() !== address) return null
    } else if (algorithm !== Algorithm.BSM) return null
    const prefix = new Script(chunks.slice(0, at)).toBinary()
    const sigma = new Sigma({ algorithm, address, signature, vin })
    if (!sigma.verifyWithHashes(inputHash(txid.toLowerCase(), input.sourceOutputIndex), Hash.sha256(prefix))) return null
    out.push({ algorithm, address, vin, ...(key ? { key } : {}) })
  }
  return out
}

/**
 * The link or unlink an output carries, with every signature verified; null
 * when it is not one or any signature fails. Whether the BAP signer was active
 * is the key chain's question (BRC-248 §6), not this parser's.
 */
export function parseIdentityLink(tx: Transaction, outputIndex: number): IdentityLinkRecord | null {
  try {
    const hex = tx.outputs[outputIndex]?.lockingScript.toHex()
    if (!hex || hex.length > 8192 || !hex.includes(TYPE_MARKER_HEX)) return null
    const chunks = expandedProtocolScript(hex).chunks
    if (chunks[0]?.op !== OP.OP_FALSE || chunks[1]?.op !== OP.OP_RETURN) return null
    const separators = chunks.flatMap((chunk, i) =>
      i > 1 && chunk.data?.length === 1 && chunk.data[0] === 0x7c ? [i] : [],
    )
    const tape = chunks.slice(2, separators[0] ?? chunks.length).map((chunk) => Utils.toUTF8(chunk.data ?? []))
    if (tape.length !== 8 || tape[0] !== MAP || tape[1] !== 'SET' || tape[2] !== 'type') return null
    if (tape[4] !== 'identityKey' || tape[6] !== 'bapId') return null
    const kind = tape[3] === TYPE.link ? 'link' : tape[3] === TYPE.unlink ? 'unlink' : null
    const identityKey = normalizeIssuerIdentityKey(tape[5])
    const bapId = normalizeBapId(tape[7])
    if (!kind || !identityKey || identityKey !== tape[5] || !bapId) return null
    const sigmas = verifiedSigmas(tx, chunks, separators)
    if (!sigmas) return null
    if (kind === 'link') {
      const [identity, bap] = sigmas
      if (sigmas.length !== 2 || identity!.key !== identityKey || bap!.algorithm !== Algorithm.BSM) return null
      if (identity!.vin !== bap!.vin) return null
      return { kind, identityKey, bapId, bapSigner: bap!.address }
    }
    const [signer] = sigmas
    if (sigmas.length !== 1) return null
    if (signer!.algorithm === Algorithm.BSM) return { kind, identityKey, bapId, bapSigner: signer!.address }
    return signer!.key === identityKey ? { kind, identityKey, bapId } : null
  } catch {
    return null
  }
}
