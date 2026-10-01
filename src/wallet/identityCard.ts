import { BSM, PrivateKey, ProtoWallet, PublicKey, Signature, Utils, type ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  parseIssuerIdentityPackage,
  issuerSignerVerdict,
  type IssuerIdentity,
  type IssuerIdentityPackage,
} from './issuerIdentity'
import { issuerIdentityFor, rememberConfirmedIssuerIdentityPackage } from './issuerIdentities'
import { normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'
import type { Chain } from './vault'

/**
 * Identity cards: a wallet presents one of its published BAP identities to
 * the people it talks to, peer to peer. The card carries the identity's whole
 * package (key chain, profile, image as Atomic BEEF) and two signatures over
 * the same statement: the wallet identity key's (BRC-3) and the identity's
 * current BAP key's (Bitcoin Signed Message, as BAP signs). Either key alone
 * cannot claim the other, and no server takes part in checking either.
 *
 * Withdrawing sends a card with no BAP ID, signed by the wallet key only. The
 * receiver keeps the newest statement per wallet key, so an older card cannot
 * be replayed over a newer one.
 */

export type IdentityCard = {
  v: 1
  /** Wallet identity key: the key handles and messageboxes address. */
  identityKey: string
  /** Presented BAP ID; null withdraws an earlier card. */
  bapId: string | null
  issuedAt: string
  /** BRC-3 by `identityKey`, hex DER. */
  identitySignature: string
  package?: IssuerIdentityPackage
  /** The identity's current BAP signing key. */
  bapSigner?: string
  /** Bitcoin Signed Message by `bapSigner`, base64 compact. */
  bapSignature?: string
}

export type IdentityCardRefusal =
  | 'malformed'
  | 'wrong-sender'
  | 'future'
  | 'stale'
  | 'identity-signature'
  | 'bap-signature'
  | 'package'
  | 'revoked'
  | 'signer'

export type IdentityCardOutcome =
  | { kind: 'presented'; identityKey: string; identity: IssuerIdentity }
  | { kind: 'withdrawn'; identityKey: string }
  | { kind: 'refused'; reason: IdentityCardRefusal }

/** What this device knows a wallet key presents. */
export type PeerIdentity =
  | { kind: 'presented'; identity: IssuerIdentity }
  /** The link is kept but the package was evicted; ask the peer again. */
  | { kind: 'missing-package'; bapId: string }

export const IDENTITY_CARD_PREFIX = 'handcash-identity-card:'
export const IDENTITY_CARD_REQUEST = 'handcash-identity-card-request:v1'

const PROTOCOL: [2, string] = [2, 'bap identity card']
const KEY_ID = '1'
const FUTURE_SKEW_MS = 10 * 60 * 1000
const MAX_LINKS = 512
const MAX_WIRE_CHARS = 240_000

type Link = { bapId: string | null; issuedAt: string; receivedAt: number }
type Links = { version: 1; links: Record<string, Link> }

const linksKey = (chain: Chain) => `${storageRegistry.identityCards.key}:${chain}`
const listeners = new Set<() => void>()
const cache = new Map<Chain, Links>()
let generation = 0

export function subscribeIdentityCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function identityCardsGeneration(): number {
  return generation
}

/** Bytes both keys sign. */
export function identityCardStatement(card: Pick<IdentityCard, 'identityKey' | 'bapId' | 'issuedAt'>): number[] {
  return Utils.toArray(
    JSON.stringify({ v: 1, identityKey: card.identityKey, bapId: card.bapId, issuedAt: card.issuedAt }),
    'utf8',
  )
}

function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null
}

export function parseIdentityCard(raw: unknown): IdentityCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const identityKey = normalizeIssuerIdentityKey(row.identityKey)
  const issuedAt = canonicalTime(row.issuedAt)
  if (row.v !== 1 || !identityKey || identityKey !== row.identityKey || !issuedAt) return null
  if (typeof row.identitySignature !== 'string' || !/^(?:[0-9a-f]{2}){8,80}$/.test(row.identitySignature))
    return null
  const base = { v: 1 as const, identityKey, issuedAt, identitySignature: row.identitySignature }
  if (row.bapId === null) {
    if (row.package !== undefined || row.bapSigner !== undefined || row.bapSignature !== undefined) return null
    return { ...base, bapId: null }
  }
  const bapId = normalizeBapId(row.bapId)
  const pkg = parseIssuerIdentityPackage(row.package)
  const bapSigner = normalizeIssuerIdentityKey(row.bapSigner)
  if (!bapId || bapId !== row.bapId || pkg?.bapId !== bapId || !bapSigner || bapSigner !== row.bapSigner)
    return null
  if (typeof row.bapSignature !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(row.bapSignature)) return null
  return { ...base, bapId, package: pkg, bapSigner, bapSignature: row.bapSignature }
}

/**
 * Sign a card for this wallet. With `presented`, the identity's current BAP
 * key countersigns; without it the card withdraws whatever was presented.
 */
export async function signIdentityCard(args: {
  rootKeyHex: string
  issuedAt: string
  presented?: { pkg: IssuerIdentityPackage; signingKey: PrivateKey }
}): Promise<IdentityCard> {
  const root = PrivateKey.fromHex(args.rootKeyHex)
  const identityKey = root.toPublicKey().toString().toLowerCase()
  const issuedAt = canonicalTime(args.issuedAt)
  if (!issuedAt) throw new Error('Identity card time is not canonical.')
  const bapId = args.presented?.pkg.bapId ?? null
  const statement = identityCardStatement({ identityKey, bapId, issuedAt })
  const { signature } = await new ProtoWallet(root).createSignature({
    data: statement,
    protocolID: PROTOCOL,
    keyID: KEY_ID,
    counterparty: 'anyone',
  })
  const card: IdentityCard = { v: 1, identityKey, bapId, issuedAt, identitySignature: Utils.toHex(signature) }
  if (!args.presented) return card
  return {
    ...card,
    package: args.presented.pkg,
    bapSigner: args.presented.signingKey.toPublicKey().toString().toLowerCase(),
    bapSignature: BSM.sign(statement, args.presented.signingKey, 'base64') as string,
  }
}

async function identitySignatureValid(card: IdentityCard): Promise<boolean> {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: identityCardStatement(card),
      signature: Utils.toArray(card.identitySignature, 'hex'),
      protocolID: PROTOCOL,
      keyID: KEY_ID,
      counterparty: card.identityKey,
    })
    return valid
  } catch {
    return false
  }
}

function bapSignatureValid(card: IdentityCard): boolean {
  try {
    return BSM.verify(
      identityCardStatement(card),
      Signature.fromCompact(card.bapSignature!, 'base64'),
      PublicKey.fromString(card.bapSigner!),
    )
  } catch {
    return false
  }
}

function readLinks(chain: Chain): Links {
  const hit = cache.get(chain)
  if (hit) return hit
  let links: Links = { version: 1, links: {} }
  try {
    const raw = durableGetItem(linksKey(chain))
    const parsed = raw ? (JSON.parse(raw) as Links) : null
    if (parsed?.version === 1 && parsed.links && typeof parsed.links === 'object') {
      const kept: Record<string, Link> = {}
      for (const [key, link] of Object.entries(parsed.links)) {
        const bapId = link?.bapId === null ? null : normalizeBapId(link?.bapId)
        if (
          normalizeIssuerIdentityKey(key) === key &&
          (bapId === null ? link.bapId === null : bapId === link.bapId) &&
          canonicalTime(link.issuedAt) &&
          Number.isFinite(link.receivedAt)
        )
          kept[key] = { bapId, issuedAt: link.issuedAt, receivedAt: link.receivedAt }
      }
      links = { version: 1, links: kept }
    }
  } catch {
    /* start empty */
  }
  cache.set(chain, links)
  return links
}

function writeLink(chain: Chain, identityKey: string, link: Link): void {
  const entries = Object.entries({ ...readLinks(chain).links, [identityKey]: link })
    .sort((a, b) => b[1].receivedAt - a[1].receivedAt)
    .slice(0, MAX_LINKS)
  const next: Links = { version: 1, links: Object.fromEntries(entries) }
  if (!durableSetItem(linksKey(chain), JSON.stringify(next))) return
  cache.set(chain, next)
  generation++
  for (const listener of listeners) listener()
}

/**
 * Verify a card and keep it. `expectedIdentityKey` is the authenticated sender
 * when the card came over a sealed envelope; a pasted card stands on its own
 * signatures. The package is header-checked before it reaches the store.
 */
export async function rememberIdentityCard(
  chain: Chain,
  raw: unknown,
  opts: { tracker: ChainTracker | null | undefined; expectedIdentityKey?: string; now?: number },
): Promise<IdentityCardOutcome> {
  const card = parseIdentityCard(raw)
  if (!card) return { kind: 'refused', reason: 'malformed' }
  if (opts.expectedIdentityKey && card.identityKey !== opts.expectedIdentityKey.trim().toLowerCase())
    return { kind: 'refused', reason: 'wrong-sender' }
  const now = opts.now ?? Date.now()
  if (Date.parse(card.issuedAt) > now + FUTURE_SKEW_MS) return { kind: 'refused', reason: 'future' }
  const prior = readLinks(chain).links[card.identityKey]
  if (prior) {
    const age = Date.parse(card.issuedAt) - Date.parse(prior.issuedAt)
    if (age < 0 || (age === 0 && prior.bapId !== card.bapId)) return { kind: 'refused', reason: 'stale' }
  }
  if (!(await identitySignatureValid(card))) return { kind: 'refused', reason: 'identity-signature' }
  if (card.bapId === null) {
    writeLink(chain, card.identityKey, { bapId: null, issuedAt: card.issuedAt, receivedAt: now })
    return { kind: 'withdrawn', identityKey: card.identityKey }
  }
  if (!bapSignatureValid(card)) return { kind: 'refused', reason: 'bap-signature' }
  const stored = await rememberConfirmedIssuerIdentityPackage(chain, card.package, opts.tracker)
  const identity = stored?.bapId === card.bapId ? issuerIdentityFor(chain, card.bapId) : null
  if (!identity) return { kind: 'refused', reason: 'package' }
  if (identity.revoked) return { kind: 'refused', reason: 'revoked' }
  if (issuerSignerVerdict(identity, card.bapSigner!) !== 'active') return { kind: 'refused', reason: 'signer' }
  writeLink(chain, card.identityKey, { bapId: card.bapId, issuedAt: card.issuedAt, receivedAt: now })
  return { kind: 'presented', identityKey: card.identityKey, identity }
}

/** The identity a wallet key presents to this device, if it still holds. */
export function peerIdentityFor(chain: Chain, identityKey: string | null | undefined): PeerIdentity | null {
  const key = normalizeIssuerIdentityKey(identityKey)
  const bapId = key ? readLinks(chain).links[key]?.bapId : null
  if (!bapId) return null
  const identity = issuerIdentityFor(chain, bapId)
  if (!identity) return { kind: 'missing-package', bapId }
  return identity.revoked ? null : { kind: 'presented', identity }
}

export function identityCardRefusalMessage(reason: IdentityCardRefusal): string {
  switch (reason) {
    case 'malformed':
      return 'This is not an identity card.'
    case 'wrong-sender':
      return 'This card belongs to a different wallet key than this contact.'
    case 'future':
      return 'This card is dated in the future; check the device clock.'
    case 'stale':
      return 'This device already holds a newer card from this wallet.'
    case 'identity-signature':
      return 'The wallet key did not sign this card.'
    case 'bap-signature':
      return 'The identity key did not sign this card.'
    case 'package':
      return 'The identity package did not verify against block headers.'
    case 'revoked':
      return 'This identity is revoked.'
    case 'signer':
      return 'The card was signed by a key this identity has retired or never declared.'
  }
}

export function isIdentityCardControl(body: string): boolean {
  return body === IDENTITY_CARD_REQUEST || body.startsWith(IDENTITY_CARD_PREFIX)
}

export function identityCardWire(card: IdentityCard): string {
  return `${IDENTITY_CARD_PREFIX}${JSON.stringify(card)}`
}

/** The card a control body carries; undefined when the body is not one. */
export function identityCardFromWire(body: string): unknown {
  if (!body.startsWith(IDENTITY_CARD_PREFIX) || body.length > MAX_WIRE_CHARS) return undefined
  try {
    return JSON.parse(body.slice(IDENTITY_CARD_PREFIX.length))
  } catch {
    return null
  }
}

export function resetIdentityCardsForTests(): void {
  cache.clear()
  generation = 0
}
