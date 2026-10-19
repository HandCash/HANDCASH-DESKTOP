import { BigNumber, ECDSA, Hash, KeyDeriver, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { isSwapAsset, type SwapAsset } from './assets'

/**
 * A direct swap offer: a standing price signed by the maker's identity key.
 * Anyone may host or relay it; nobody can alter it, and every wallet checks
 * the signature, the bounds and the expiry itself before it is shown.
 *
 * The maker gives `give` and wants `get`. A taker pays any amount of `get`
 * between `minGet` and `maxGet` and receives `give` at `price`: `price.give`
 * units for every `price.get` units, rounded down for the taker. The swap
 * itself is atomic and wallet to wallet; an offer only says what the maker
 * will do.
 *
 * Signed with a BRC-42 child of the identity key under the wallet-only
 * protocol `swap order` (key id = the offer's nonce, counterparty anyone), so
 * an app holding a signing grant cannot sign an offer in the user's name.
 */

export const SWAP_OFFER_PROTOCOL: [2, string] = [2, 'swap order']
/** Longest an offer may stand. */
export const MAX_OFFER_TTL_MS = 24 * 60 * 60_000
/** Clock skew tolerated on `createdAt`. */
const MAX_SKEW_MS = 5 * 60_000
const DOMAIN = 'handcash swap offer v1\n'
const HEX64 = /^[0-9a-f]{64}$/
const UNITS = /^[1-9]\d{0,17}$/

export type SwapOffer = {
  v: 1
  /** Maker identity key, compressed hex. */
  maker: string
  give: SwapAsset
  get: SwapAsset
  price: { give: string; get: string }
  minGet: string
  maxGet: string
  createdAt: number
  expiresAt: number
  /** 32 random bytes, hex: the offer's id and its signing key id. */
  nonce: string
  /** Where takers reach the maker (BRC-33). */
  messagebox?: string
}

export type SignedSwapOffer = SwapOffer & { sig: string }

export type OfferRefusal = 'malformed' | 'signature' | 'expired' | 'not-yet-valid' | 'too-long'

/** The bytes a maker signs: a domain tag and every field in a fixed order. */
export function swapOfferDigest(offer: SwapOffer): number[] {
  const fields = [
    offer.v,
    offer.maker,
    offer.give,
    offer.get,
    offer.price.give,
    offer.price.get,
    offer.minGet,
    offer.maxGet,
    offer.createdAt,
    offer.expiresAt,
    offer.nonce,
    offer.messagebox ?? '',
  ]
  return Hash.sha256(Utils.toArray(DOMAIN + JSON.stringify(fields), 'utf8'))
}

function wellFormed(o: Partial<SignedSwapOffer>): o is SignedSwapOffer {
  return (
    o.v === 1 &&
    typeof o.maker === 'string' &&
    /^0[23][0-9a-f]{64}$/.test(o.maker) &&
    isSwapAsset(o.give) &&
    isSwapAsset(o.get) &&
    o.give !== o.get &&
    typeof o.price === 'object' &&
    o.price !== null &&
    UNITS.test(String(o.price.give)) &&
    UNITS.test(String(o.price.get)) &&
    UNITS.test(String(o.minGet)) &&
    UNITS.test(String(o.maxGet)) &&
    BigInt(o.minGet as string) <= BigInt(o.maxGet as string) &&
    Number.isSafeInteger(o.createdAt) &&
    Number.isSafeInteger(o.expiresAt) &&
    typeof o.nonce === 'string' &&
    HEX64.test(o.nonce) &&
    (o.messagebox === undefined || (typeof o.messagebox === 'string' && /^https:\/\/\S+$/.test(o.messagebox))) &&
    typeof o.sig === 'string' &&
    /^[0-9a-f]{16,160}$/.test(o.sig)
  )
}

/** Sign `offer` with the identity root key `root`; `offer.maker` must be its public key. */
export function signSwapOffer(offer: SwapOffer, root: PrivateKey): SignedSwapOffer {
  if (root.toPublicKey().toString() !== offer.maker) throw new Error('the offer names another maker')
  const key = new KeyDeriver(root).derivePrivateKey(SWAP_OFFER_PROTOCOL, offer.nonce, 'anyone')
  const sig = ECDSA.sign(new BigNumber(swapOfferDigest(offer)), key, true)
  return { ...offer, sig: Utils.toHex(sig.toDER() as number[]) }
}

const CANCEL_DOMAIN = 'handcash swap offer cancel v1\n'

/** The bytes a maker signs to withdraw its offer `nonce`. */
export function swapOfferCancelDigest(nonce: string): number[] {
  return Hash.sha256(Utils.toArray(CANCEL_DOMAIN + nonce, 'utf8'))
}

/** Withdraw an offer: the same key that signed it signs its nonce under the cancel domain. */
export function signSwapOfferCancel(nonce: string, root: PrivateKey): string {
  const key = new KeyDeriver(root).derivePrivateKey(SWAP_OFFER_PROTOCOL, nonce, 'anyone')
  return Utils.toHex(ECDSA.sign(new BigNumber(swapOfferCancelDigest(nonce)), key, true).toDER() as number[])
}

/** Check an offer as a taker's wallet must before showing it: shape, maker signature, and that it stands now. */
export function verifySwapOffer(value: unknown, now: number): { ok: true; offer: SignedSwapOffer } | { ok: false; reason: OfferRefusal } {
  const o = (value && typeof value === 'object' ? value : {}) as Partial<SignedSwapOffer>
  if (!wellFormed(o)) return { ok: false, reason: 'malformed' }
  if (o.expiresAt <= now) return { ok: false, reason: 'expired' }
  if (o.createdAt > now + MAX_SKEW_MS) return { ok: false, reason: 'not-yet-valid' }
  if (o.expiresAt - o.createdAt > MAX_OFFER_TTL_MS) return { ok: false, reason: 'too-long' }
  try {
    const { sig, ...offer } = o
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(SWAP_OFFER_PROTOCOL, o.nonce, PublicKey.fromString(o.maker).toString())
    const valid = ECDSA.verify(new BigNumber(swapOfferDigest(offer)), Signature.fromDER(Utils.toArray(sig, 'hex')), pub)
    return valid ? { ok: true, offer: o } : { ok: false, reason: 'signature' }
  } catch {
    return { ok: false, reason: 'signature' }
  }
}

/** What a taker paying `pay` of `offer.get` receives of `offer.give`; null outside the offer's bounds. */
export function fillOffer(offer: SwapOffer, pay: bigint): bigint | null {
  if (pay < BigInt(offer.minGet) || pay > BigInt(offer.maxGet)) return null
  return (pay * BigInt(offer.price.give)) / BigInt(offer.price.get)
}
