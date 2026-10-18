import { BigNumber, Curve, Hash, Point, PublicKey, SymmetricKey, Utils } from '@bsv/sdk'

/**
 * BRC-42 (BKDS) and BRC-43 invoice numbers written from the curve up.
 *
 * Shares no code with `KeyDeriver` or `PrivateKey.deriveChild`: a wallet that
 * agrees with this module agrees with the standard, not merely with the SDK it
 * may itself be built on. Every function here is checked against the vectors
 * published in BRC-42 before it is trusted to judge a wallet.
 */

const curve = new Curve()

/** BRC-43 `anyone`: the private key 1, whose public key is G. */
export const ANYONE_PRIVATE_KEY_HEX = '01'.padStart(64, '0')
export const ANYONE_PUBLIC_KEY_HEX = Utils.toHex(curve.g.encode(true) as number[])

/** BRC-100 `ProtocolString5To400Characters` / `KeyIDStringUnder800Characters`. */
export const PROTOCOL_NAME_MIN = 5
export const PROTOCOL_NAME_MAX = 400
export const KEY_ID_MAX = 800

export type SecurityLevel = 0 | 1 | 2
export type ProtocolID = [SecurityLevel, string]

function scalar(hex: string): BigNumber {
  return new BigNumber(hex, 16)
}

function point(publicKeyHex: string): Point {
  return PublicKey.fromString(publicKeyHex)
}

function pointHex(p: Point): string {
  return Utils.toHex(p.encode(true) as number[])
}

/** ECDH: `privateKey · publicKey`. Symmetric: a·B = b·A. */
export function sharedSecret(privateKeyHex: string, publicKeyHex: string): Point {
  return point(publicKeyHex).mul(scalar(privateKeyHex))
}

/** HMAC-SHA256 keyed by the compressed shared secret over the UTF-8 invoice number, big-endian. */
export function invoiceScalar(shared: Point, invoiceNumber: string): BigNumber {
  const hmac = Hash.sha256hmac(shared.encode(true) as number[], Utils.toArray(invoiceNumber, 'utf8'))
  return new BigNumber(hmac).umod(curve.n)
}

/** Raw HMAC bytes: the BRC-69 specific linkage for one invoice number. */
export function invoiceLinkage(shared: Point, invoiceNumber: string): number[] {
  return Hash.sha256hmac(shared.encode(true) as number[], Utils.toArray(invoiceNumber, 'utf8'))
}

/** The sender's view: the recipient's child public key. */
export function childPublicKey(args: {
  senderPrivateKey: string
  recipientPublicKey: string
  invoiceNumber: string
}): string {
  const shared = sharedSecret(args.senderPrivateKey, args.recipientPublicKey)
  const offset = curve.g.mul(invoiceScalar(shared, args.invoiceNumber))
  return pointHex(point(args.recipientPublicKey).add(offset))
}

/** The recipient's view: its own child private key. */
export function childPrivateKey(args: {
  recipientPrivateKey: string
  senderPublicKey: string
  invoiceNumber: string
}): string {
  const shared = sharedSecret(args.recipientPrivateKey, args.senderPublicKey)
  const child = scalar(args.recipientPrivateKey).add(invoiceScalar(shared, args.invoiceNumber)).umod(curve.n)
  return child.toHex(32)
}

export function publicKeyOf(privateKeyHex: string): string {
  return pointHex(curve.g.mul(scalar(privateKeyHex)))
}

/** `publicKey + G·linkage`: what a verifier rebuilds from a revealed specific linkage. */
export function offsetPublicKey(publicKeyHex: string, linkage: number[]): string {
  return pointHex(point(publicKeyHex).add(curve.g.mul(new BigNumber(linkage).umod(curve.n))))
}

/**
 * BRC-2 symmetric key between two child keys: the x coordinate of
 * `ownChildPrivate · peerChildPublic`, as the wallet stack encodes it.
 */
export function brc2SymmetricKey(args: {
  ownPrivateKey: string
  peerPublicKey: string
  invoiceNumber: string
}): SymmetricKey {
  const ownChild = childPrivateKey({
    recipientPrivateKey: args.ownPrivateKey,
    senderPublicKey: args.peerPublicKey,
    invoiceNumber: args.invoiceNumber,
  })
  const peerChild = childPublicKey({
    senderPrivateKey: args.ownPrivateKey,
    recipientPublicKey: args.peerPublicKey,
    invoiceNumber: args.invoiceNumber,
  })
  const shared = point(peerChild).mul(scalar(ownChild))
  return new SymmetricKey(shared.getX().toArray())
}

export type InvoiceRefusal =
  | 'security-level'
  | 'protocol-too-short'
  | 'protocol-too-long'
  | 'protocol-double-space'
  | 'protocol-charset'
  | 'protocol-suffix'
  | 'key-id-empty'
  | 'key-id-too-long'

/** BRC-43 normalisation with BRC-100 bounds, or the named rule the input breaks. */
export function brc43Invoice(
  protocolID: readonly [number, string],
  keyID: string,
): { ok: true; invoiceNumber: string; protocolName: string } | { ok: false; refusal: InvoiceRefusal } {
  const [level, rawName] = protocolID
  if (!Number.isInteger(level) || level < 0 || level > 2) return { ok: false, refusal: 'security-level' }
  const name = rawName.toLowerCase().trim()
  if (name.length < PROTOCOL_NAME_MIN) return { ok: false, refusal: 'protocol-too-short' }
  if (name.length > PROTOCOL_NAME_MAX) return { ok: false, refusal: 'protocol-too-long' }
  if (name.includes('  ')) return { ok: false, refusal: 'protocol-double-space' }
  if (!/^[a-z0-9 ]+$/.test(name)) return { ok: false, refusal: 'protocol-charset' }
  if (name.endsWith(' protocol')) return { ok: false, refusal: 'protocol-suffix' }
  if (keyID.length < 1) return { ok: false, refusal: 'key-id-empty' }
  if (keyID.length > KEY_ID_MAX) return { ok: false, refusal: 'key-id-too-long' }
  return { ok: true, invoiceNumber: `${level}-${name}-${keyID}`, protocolName: name }
}

export function invoiceOrThrow(protocolID: readonly [number, string], keyID: string): string {
  const result = brc43Invoice(protocolID, keyID)
  if (!result.ok) throw new Error(`Invalid BRC-43 invoice: ${result.refusal}`)
  return result.invoiceNumber
}

/** BRC-42 § Test Vectors — private key derivation. */
export const BRC42_PRIVATE_VECTORS = [
  {
    senderPublicKey: '033f9160df035156f1c48e75eae99914fa1a1546bec19781e8eddb900200bff9d1',
    recipientPrivateKey: '6a1751169c111b4667a6539ee1be6b7cd9f6e9c8fe011a5f2fe31e03a15e0ede',
    invoiceNumber: 'f3WCaUmnN9U=',
    privateKey: '761656715bbfa172f8f9f58f5af95d9d0dfd69014cfdcacc9a245a10ff8893ef',
  },
  {
    senderPublicKey: '027775fa43959548497eb510541ac34b01d5ee9ea768de74244a4a25f7b60fae8d',
    recipientPrivateKey: 'cab2500e206f31bc18a8af9d6f44f0b9a208c32d5cca2b22acfe9d1a213b2f36',
    invoiceNumber: '2Ska++APzEc=',
    privateKey: '09f2b48bd75f4da6429ac70b5dce863d5ed2b350b6f2119af5626914bdb7c276',
  },
  {
    senderPublicKey: '0338d2e0d12ba645578b0955026ee7554889ae4c530bd7a3b6f688233d763e169f',
    recipientPrivateKey: '7a66d0896f2c4c2c9ac55670c71a9bc1bdbdfb4e8786ee5137cea1d0a05b6f20',
    invoiceNumber: 'cN/yQ7+k7pg=',
    privateKey: '7114cd9afd1eade02f76703cc976c241246a2f26f5c4b7a3a0150ecc745da9f0',
  },
  {
    senderPublicKey: '02830212a32a47e68b98d477000bde08cb916f4d44ef49d47ccd4918d9aaabe9c8',
    recipientPrivateKey: '6e8c3da5f2fb0306a88d6bcd427cbfba0b9c7f4c930c43122a973d620ffa3036',
    invoiceNumber: 'm2/QAsmwaA4=',
    privateKey: 'f1d6fb05da1225feeddd1cf4100128afe09c3c1aadbffbd5c8bd10d329ef8f40',
  },
  {
    senderPublicKey: '03f20a7e71c4b276753969e8b7e8b67e2dbafc3958d66ecba98dedc60a6615336d',
    recipientPrivateKey: 'e9d174eff5708a0a41b32624f9b9cc97ef08f8931ed188ee58d5390cad2bf68e',
    invoiceNumber: 'jgpUIjWFlVQ=',
    privateKey: 'c5677c533f17c30f79a40744b18085632b262c0c13d87f3848c385f1389f79a6',
  },
] as const

/** BRC-42 § Test Vectors — public key derivation. */
export const BRC42_PUBLIC_VECTORS = [
  {
    senderPrivateKey: '583755110a8c059de5cd81b8a04e1be884c46083ade3f779c1e022f6f89da94c',
    recipientPublicKey: '02c0c1e1a1f7d247827d1bcf399f0ef2deef7695c322fd91a01a91378f101b6ffc',
    invoiceNumber: 'IBioA4D/OaE=',
    publicKey: '03c1bf5baadee39721ae8c9882b3cf324f0bf3b9eb3fc1b8af8089ca7a7c2e669f',
  },
  {
    senderPrivateKey: '2c378b43d887d72200639890c11d79e8f22728d032a5733ba3d7be623d1bb118',
    recipientPublicKey: '039a9da906ecb8ced5c87971e9c2e7c921e66ad450fd4fc0a7d569fdb5bede8e0f',
    invoiceNumber: 'PWYuo9PDKvI=',
    publicKey: '0398cdf4b56a3b2e106224ff3be5253afd5b72de735d647831be51c713c9077848',
  },
  {
    senderPrivateKey: 'd5a5f70b373ce164998dff7ecd93260d7e80356d3d10abf928fb267f0a6c7be6',
    recipientPublicKey: '02745623f4e5de046b6ab59ce837efa1a959a8f28286ce9154a4781ec033b85029',
    invoiceNumber: 'X9pnS+bByrM=',
    publicKey: '0273eec9380c1a11c5a905e86c2d036e70cbefd8991d9a0cfca671f5e0bbea4a3c',
  },
  {
    senderPrivateKey: '46cd68165fd5d12d2d6519b02feb3f4d9c083109de1bfaa2b5c4836ba717523c',
    recipientPublicKey: '031e18bb0bbd3162b886007c55214c3c952bb2ae6c33dd06f57d891a60976003b1',
    invoiceNumber: '+ktmYRHv3uQ=',
    publicKey: '034c5c6bf2e52e8de8b2eb75883090ed7d1db234270907f1b0d1c2de1ddee5005d',
  },
  {
    senderPrivateKey: '7c98b8abd7967485cfb7437f9c56dd1e48ceb21a4085b8cdeb2a647f62012db4',
    recipientPublicKey: '03c8885f1e1ab4facd0f3272bb7a48b003d2e608e1619fb38b8be69336ab828f37',
    invoiceNumber: 'PPfDTTcl1ao=',
    publicKey: '03304b41cfa726096ffd9d8907fe0835f888869eda9653bca34eb7bcab870d3779',
  },
] as const
