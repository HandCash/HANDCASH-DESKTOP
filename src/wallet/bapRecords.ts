import { BigNumber, BSM, Hash, KeyDeriver, OP, PrivateKey, Script, Signature, Utils } from '@bsv/sdk'

/**
 * BAP (Bitcoin Attestation Protocol) records as 1Sat / Yours wallets write them.
 *
 *   ID     OP_FALSE OP_RETURN 1BAP… ID <bapId> <address> | AIP BITCOIN_ECDSA <signer> <sig>
 *   ALIAS  OP_FALSE OP_RETURN 1BAP… ALIAS <bapId> <schema.org JSON> | AIP …
 *   B file OP_FALSE OP_RETURN 19Hx… <bytes> <media type> binary
 *
 * The BAP ID is the hash of the root address (`identity-0`). The first ID
 * record is signed by the root and declares `identity-1`; each rotation is
 * signed by the outgoing key and declares the next one. `ID <bapId> 0` signed
 * by the root revokes the identity. All outputs are 0-sat and unspendable.
 */

export const BAP_PROTOCOL_ID: [1, 'sigma'] = [1, 'sigma']
export const BAP_KEY_ID = 'identity'
export const BAP_BASKET = 'bap'
/**
 * Records of imported issuer masters. 1Sat BRC-100 apps read every `type:id`
 * in `bap` as this wallet's own key tree, so another master's chain must not
 * sit there.
 */
export const IMPORTED_BAP_BASKET = 'bap issuer'
export const BAP_BITCOM_ADDRESS = '1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT'
export const AIP_BITCOM_ADDRESS = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
export const B_BITCOM_ADDRESS = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const AIP_ALGORITHM = 'BITCOIN_ECDSA'
export const BAP_REVOKED_ADDRESS = '0'

export type BapRecord =
  | { kind: 'id'; bapId: string; address: string; signer: string }
  | { kind: 'alias'; bapId: string; profile: Record<string, unknown>; signer: string }

export type BFile = { bytes: Uint8Array; contentType: string }

export function bapIdForAddress(address: string): string {
  return Utils.toBase58(Hash.ripemd160(Hash.sha256(Utils.toArray(address, 'utf8'))))
}

/** `identity-<seq>` under `[1,'sigma']`, self counterparty. Seq 0 is the root. */
export function bapKey(master: PrivateKey, seq: number): PrivateKey {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid BAP key sequence.')
  return new KeyDeriver(master).derivePrivateKey(BAP_PROTOCOL_ID, `${BAP_KEY_ID}-${seq}`, 'self')
}

export function bapAddress(master: PrivateKey, seq: number): string {
  return bapKey(master, seq).toAddress()
}

export function bapIdFor(master: PrivateKey): string {
  return bapIdForAddress(bapAddress(master, 0))
}

function aipSignedScript(fields: number[][], signer: PrivateKey): string {
  const message = [OP.OP_RETURN, ...fields.flat(), 0x7c]
  const signature = Utils.toArray(BSM.sign(message, signer, 'base64') as string, 'base64')
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  for (const field of fields) script.writeBin(field)
  for (const field of ['|', AIP_BITCOM_ADDRESS, AIP_ALGORITHM, signer.toAddress()])
    script.writeBin(Utils.toArray(field, 'utf8'))
  script.writeBin(signature)
  return script.toHex()
}

const utf8 = (value: string) => Utils.toArray(value, 'utf8')

export function bapIdScript(args: { bapId: string; address: string; signer: PrivateKey }): string {
  return aipSignedScript(
    [utf8(BAP_BITCOM_ADDRESS), utf8('ID'), utf8(args.bapId), utf8(args.address)],
    args.signer,
  )
}

export function bapAliasScript(args: {
  bapId: string
  profile: Record<string, unknown>
  signer: PrivateKey
}): string {
  return aipSignedScript(
    [utf8(BAP_BITCOM_ADDRESS), utf8('ALIAS'), utf8(args.bapId), utf8(JSON.stringify(args.profile))],
    args.signer,
  )
}

export function bFileScript(file: BFile): string {
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  script.writeBin(utf8(B_BITCOM_ADDRESS))
  script.writeBin(Array.from(file.bytes))
  script.writeBin(utf8(file.contentType))
  script.writeBin(utf8('binary'))
  return script.toHex()
}

const PIPE = 0x7c

/** Pushes after `OP_FALSE OP_RETURN`, or null when the script is not pure data. */
function dataPushes(scriptHex: string): number[][] | null {
  const bytes = Utils.toArray(scriptHex, 'hex')
  let at = bytes[0] === OP.OP_FALSE && bytes[1] === OP.OP_RETURN ? 2 : bytes[0] === OP.OP_RETURN ? 1 : -1
  if (at < 0) return null
  const pushes: number[][] = []
  while (at < bytes.length) {
    const op = bytes[at++]!
    let size: number
    if (op === OP.OP_0) size = 0
    else if (op <= 75) size = op
    else if (op === OP.OP_PUSHDATA1) size = bytes[at++] ?? -1
    else if (op === OP.OP_PUSHDATA2) {
      size = (bytes[at] ?? -1) | ((bytes[at + 1] ?? 0) << 8)
      at += 2
    } else if (op === OP.OP_PUSHDATA4) {
      size = ((bytes[at] ?? -1) | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
      at += 4
    } else return null
    if (size < 0 || at + size > bytes.length) return null
    pushes.push(bytes.slice(at, at + size))
    at += size
  }
  return pushes
}

/** Bitcom protocols: push runs separated by a lone `|`. */
function protocols(pushes: number[][]): number[][][] {
  const out: number[][][] = [[]]
  for (const push of pushes) {
    if (push.length === 1 && push[0] === PIPE) out.push([])
    else out[out.length - 1]!.push(push)
  }
  return out
}

const text = (field: number[] | null | undefined, max = 256): string | null =>
  field && field.length <= max ? Utils.toUTF8(field) : null

/**
 * The 65-byte compact signature: raw, as 1Sat wallets write it, or its base64
 * text, as the AIP specification and earlier BAP libraries do.
 */
function compactSignature(field: number[]): number[] | null {
  if (field.length === 65) return field
  if (field.length !== 88) return null
  const decoded = Utils.toArray(Utils.toUTF8(field), 'base64')
  return decoded.length === 65 ? decoded : null
}

/** AIP over every preceding field: the address whose key signed `OP_RETURN ‖ fields ‖ |`. */
function aipSigner(signed: number[][], aip: number[][]): string | null {
  if (aip.length !== 4 || text(aip[0]) !== AIP_BITCOM_ADDRESS || text(aip[1]) !== AIP_ALGORITHM) return null
  const address = text(aip[2])
  const compact = compactSignature(aip[3]!)
  if (!address || !compact) return null
  const message = [OP.OP_RETURN, ...signed.flat(), PIPE]
  const hash = new BigNumber(BSM.magicHash(message))
  const recovery = (compact[0]! - 27) & 3
  const key = Signature.fromCompact(compact).RecoverPublicKey(recovery, hash)
  return key.toAddress() === address ? address : null
}

/** A BAP ID or ALIAS record whose AIP signature verifies over every field. */
export function parseBapRecord(scriptHex: string): BapRecord | null {
  try {
    const pushes = dataPushes(scriptHex)
    const parts = pushes ? protocols(pushes) : []
    if (parts.length !== 2) return null
    const [bap, aip] = parts as [number[][], number[][]]
    if (text(bap[0]) !== BAP_BITCOM_ADDRESS || bap.length !== 4) return null
    const signer = aipSigner(bap, aip)
    const kind = text(bap[1])
    const bapId = text(bap[2])
    if (!signer || !bapId) return null
    if (kind === 'ID') {
      const address = text(bap[3])
      return address ? { kind: 'id', bapId, address, signer } : null
    }
    if (kind === 'ALIAS') {
      const json = text(bap[3], 8192)
      const profile: unknown = json ? JSON.parse(json) : null
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
      return { kind: 'alias', bapId, profile: profile as Record<string, unknown>, signer }
    }
    return null
  } catch {
    return null
  }
}

/** The B:// file an output carries, or null. */
export function parseBFile(scriptHex: string, maxBytes: number): BFile | null {
  try {
    const pushes = dataPushes(scriptHex)
    const b = pushes ? protocols(pushes)[0] : null
    if (!b || text(b[0]) !== B_BITCOM_ADDRESS) return null
    const bytes = b[1]
    const contentType = text(b[2])
    if (!bytes || bytes.length === 0 || bytes.length > maxBytes || !contentType) return null
    if (b[3] && text(b[3]) !== 'binary') return null
    return { bytes: Uint8Array.from(bytes), contentType: contentType.toLowerCase() }
  } catch {
    return null
  }
}
