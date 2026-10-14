import { BSM, PrivateKey, ProtoWallet, PublicKey, Signature, Utils, type ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { parseIdentityKeyPackage, type IdentityKeyPackage } from './identityProfile'
import {
  parseIssuerIdentityPackage,
  issuerSignerVerdict,
  profileFromBap,
  type IssuerIdentityPackage,
  type IssuerProfile,
} from './issuerIdentity'
import {
  holdIssuerIdentities,
  identityKeyProfile,
  issuerIdentityFor,
  rememberConfirmedIssuerIdentityPackage,
  rememberIdentityKeyPackage,
} from './issuerIdentities'
import { normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'
import type { Chain } from './vault'

/**
 * Identity cards: a wallet presents one of the identity keys it controls to
 * the people it talks to, peer to peer. A card names the wallet key and the
 * presented key, carries the presented key's BRC-248 package (its own signed
 * profile and image, and its linked BAP profile when that fits), and is
 * signed over the same statement by both keys (BRC-3). Either key alone
 * cannot claim the other, and no server takes part in checking either.
 *
 * Withdrawing sends a card presenting nothing, signed by the wallet key only.
 * The receiver keeps the newest statement per wallet key, so an older card
 * cannot be replayed over a newer one. Version 1 cards, which presented a BAP
 * identity countersigned by its current BAP key, are still accepted.
 */

export type IdentityCardV1 = {
  v: 1
  identityKey: string
  bapId: string | null
  issuedAt: string
  identitySignature: string
  package?: IssuerIdentityPackage
  bapSigner?: string
  bapSignature?: string
}

export type IdentityCardV2 = {
  v: 2
  /** Wallet identity key: the key handles and messageboxes address. */
  identityKey: string
  /** Presented identity key; null withdraws an earlier card. */
  presents: string | null
  issuedAt: string
  /** BRC-3 by `identityKey`, hex DER. */
  identitySignature: string
  package?: IdentityKeyPackage
  /** BRC-3 by `presents`, hex DER; absent when it is the wallet key. */
  presentedSignature?: string
}

export type IdentityCard = IdentityCardV1 | IdentityCardV2

export type IdentityCardRefusal =
  | 'malformed'
  | 'wrong-sender'
  | 'future'
  | 'stale'
  | 'identity-signature'
  | 'presented-signature'
  | 'profile'
  | 'bap-signature'
  | 'package'
  | 'revoked'
  | 'signer'

export type IdentityCardOutcome =
  | { kind: 'presented'; identityKey: string; profile: IssuerProfile }
  | { kind: 'withdrawn'; identityKey: string }
  | { kind: 'refused'; reason: IdentityCardRefusal }

/** What this device knows a wallet key presents. */
export type PeerIdentity =
  | { kind: 'presented'; profile: IssuerProfile }
  /** The link is kept but the profile was evicted; ask the peer again. */
  | { kind: 'missing-package'; id: string }

export const IDENTITY_CARD_PREFIX = 'handcash-identity-card:'
export const IDENTITY_CARD_REQUEST = 'handcash-identity-card-request:v1'

const PROTOCOL_V1: [2, string] = [2, 'bap identity card']
const PROTOCOL: [2, string] = [2, 'identity card']
const KEY_ID = '1'
const FUTURE_SKEW_MS = 10 * 60 * 1000
const MAX_LINKS = 512
const MAX_WIRE_CHARS = 240_000
const HEX_SIGNATURE = /^(?:[0-9a-f]{2}){8,80}$/

/** What a wallet key presents: an identity key (v2), a BAP ID (v1), or nothing. */
type Presents = { kind: 'key'; identityKey: string } | { kind: 'bap'; bapId: string } | null
type Link = { presents: Presents; issuedAt: string; receivedAt: number }
type StoredLink = { key?: string; bapId?: string; issuedAt: string; receivedAt: number }
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

/** Bytes every key on the card signs. */
export function identityCardStatement(
  card:
    | Pick<IdentityCardV1, 'v' | 'identityKey' | 'bapId' | 'issuedAt'>
    | Pick<IdentityCardV2, 'v' | 'identityKey' | 'presents' | 'issuedAt'>,
): number[] {
  const statement =
    card.v === 1
      ? { v: 1, identityKey: card.identityKey, bapId: card.bapId, issuedAt: card.issuedAt }
      : { v: 2, identityKey: card.identityKey, presents: card.presents, issuedAt: card.issuedAt }
  return Utils.toArray(JSON.stringify(statement), 'utf8')
}

function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null
}

function parseV1(row: Record<string, unknown>, base: { identityKey: string; issuedAt: string; identitySignature: string }): IdentityCardV1 | null {
  if (row.bapId === null) {
    if (row.package !== undefined || row.bapSigner !== undefined || row.bapSignature !== undefined) return null
    return { v: 1, ...base, bapId: null }
  }
  const bapId = normalizeBapId(row.bapId)
  const pkg = parseIssuerIdentityPackage(row.package)
  const bapSigner = normalizeIssuerIdentityKey(row.bapSigner)
  if (!bapId || bapId !== row.bapId || pkg?.bapId !== bapId || !bapSigner || bapSigner !== row.bapSigner)
    return null
  if (typeof row.bapSignature !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(row.bapSignature)) return null
  return { v: 1, ...base, bapId, package: pkg, bapSigner, bapSignature: row.bapSignature }
}

function parseV2(row: Record<string, unknown>, base: { identityKey: string; issuedAt: string; identitySignature: string }): IdentityCardV2 | null {
  if (row.presents === null) {
    if (row.package !== undefined || row.presentedSignature !== undefined) return null
    return { v: 2, ...base, presents: null }
  }
  const presents = normalizeIssuerIdentityKey(row.presents)
  const pkg = parseIdentityKeyPackage(row.package)
  if (!presents || presents !== row.presents || pkg?.identityKey !== presents) return null
  if (presents === base.identityKey) {
    if (row.presentedSignature !== undefined) return null
    return { v: 2, ...base, presents, package: pkg }
  }
  if (typeof row.presentedSignature !== 'string' || !HEX_SIGNATURE.test(row.presentedSignature)) return null
  return { v: 2, ...base, presents, package: pkg, presentedSignature: row.presentedSignature }
}

export function parseIdentityCard(raw: unknown): IdentityCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const identityKey = normalizeIssuerIdentityKey(row.identityKey)
  const issuedAt = canonicalTime(row.issuedAt)
  if (!identityKey || identityKey !== row.identityKey || !issuedAt) return null
  if (typeof row.identitySignature !== 'string' || !HEX_SIGNATURE.test(row.identitySignature)) return null
  const base = { identityKey, issuedAt, identitySignature: row.identitySignature }
  if (row.v === 1) return parseV1(row, base)
  if (row.v === 2) return parseV2(row, base)
  return null
}

async function brc3Sign(key: PrivateKey, data: number[]): Promise<string> {
  const { signature } = await new ProtoWallet(key).createSignature({
    data,
    protocolID: PROTOCOL,
    keyID: KEY_ID,
    counterparty: 'anyone',
  })
  return Utils.toHex(signature)
}

/**
 * Sign a card for this wallet. With `presented`, the presented key's master
 * countersigns unless it is the wallet key; without it the card withdraws
 * whatever was presented.
 */
export async function signIdentityCard(args: {
  rootKeyHex: string
  issuedAt: string
  presented?: { pkg: IdentityKeyPackage; signingKey: PrivateKey }
}): Promise<IdentityCardV2> {
  const root = PrivateKey.fromHex(args.rootKeyHex)
  const identityKey = root.toPublicKey().toString().toLowerCase()
  const issuedAt = canonicalTime(args.issuedAt)
  if (!issuedAt) throw new Error('Identity card time is not canonical.')
  const presents = args.presented?.pkg.identityKey ?? null
  if (args.presented && args.presented.signingKey.toPublicKey().toString().toLowerCase() !== presents)
    throw new Error('The presented key does not match its package.')
  const statement = identityCardStatement({ v: 2, identityKey, presents, issuedAt })
  const card: IdentityCardV2 = { v: 2, identityKey, presents, issuedAt, identitySignature: await brc3Sign(root, statement) }
  if (!args.presented) return card
  return {
    ...card,
    package: args.presented.pkg,
    ...(presents !== identityKey ? { presentedSignature: await brc3Sign(args.presented.signingKey, statement) } : {}),
  }
}

async function brc3Valid(card: IdentityCard, signer: string, signature: string): Promise<boolean> {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: identityCardStatement(card),
      signature: Utils.toArray(signature, 'hex'),
      protocolID: card.v === 1 ? PROTOCOL_V1 : PROTOCOL,
      keyID: KEY_ID,
      counterparty: signer,
    })
    return valid
  } catch {
    return false
  }
}

function bapSignatureValid(card: IdentityCardV1): boolean {
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

function presentsOf(card: IdentityCard): Presents {
  if (card.v === 1) return card.bapId ? { kind: 'bap', bapId: card.bapId } : null
  return card.presents ? { kind: 'key', identityKey: card.presents } : null
}

function samePresents(a: Presents, b: Presents): boolean {
  if (!a || !b) return a === b
  return a.kind === 'key' ? b.kind === 'key' && a.identityKey === b.identityKey : b.kind === 'bap' && a.bapId === b.bapId
}

function linkFromStored(key: string, link: StoredLink | undefined): Link | null {
  if (!link || normalizeIssuerIdentityKey(key) !== key || !canonicalTime(link.issuedAt) || !Number.isFinite(link.receivedAt))
    return null
  const base = { issuedAt: link.issuedAt, receivedAt: link.receivedAt }
  if (link.key !== undefined) {
    const presented = normalizeIssuerIdentityKey(link.key)
    return presented === link.key ? { presents: { kind: 'key', identityKey: presented }, ...base } : null
  }
  if (link.bapId === undefined || link.bapId === null) return { presents: null, ...base }
  const bapId = normalizeBapId(link.bapId)
  return bapId === link.bapId ? { presents: { kind: 'bap', bapId }, ...base } : null
}

function storedLink(link: Link): StoredLink {
  const base = { issuedAt: link.issuedAt, receivedAt: link.receivedAt }
  if (link.presents?.kind === 'key') return { key: link.presents.identityKey, ...base }
  if (link.presents?.kind === 'bap') return { bapId: link.presents.bapId, ...base }
  return base
}

function readLinks(chain: Chain): Links {
  const hit = cache.get(chain)
  if (hit) return hit
  let links: Links = { version: 1, links: {} }
  try {
    const raw = durableGetItem(linksKey(chain))
    const parsed = raw ? (JSON.parse(raw) as { version?: unknown; links?: Record<string, StoredLink> }) : null
    if (parsed?.version === 1 && parsed.links && typeof parsed.links === 'object') {
      const kept: Record<string, Link> = {}
      for (const [key, value] of Object.entries(parsed.links)) {
        const link = linkFromStored(key, value)
        if (link) kept[key] = link
      }
      links = { version: 1, links: kept }
    }
  } catch {
    /* start empty */
  }
  cache.set(chain, links)
  holdLinkedIdentities(chain, links)
  return links
}

function holdLinkedIdentities(chain: Chain, links: Links): void {
  holdIssuerIdentities(
    chain,
    linksKey(chain),
    Object.values(links.links).map((link) =>
      link.presents?.kind === 'key' ? link.presents.identityKey : link.presents?.bapId,
    ),
  )
}

function writeLink(chain: Chain, identityKey: string, link: Link): void {
  const entries = Object.entries({ ...readLinks(chain).links, [identityKey]: link })
    .sort((a, b) => b[1].receivedAt - a[1].receivedAt)
    .slice(0, MAX_LINKS)
  const stored = { version: 1, links: Object.fromEntries(entries.map(([key, value]) => [key, storedLink(value)])) }
  if (!durableSetItem(linksKey(chain), JSON.stringify(stored))) return
  const next: Links = { version: 1, links: Object.fromEntries(entries) }
  cache.set(chain, next)
  holdLinkedIdentities(chain, next)
  generation++
  for (const listener of listeners) listener()
}

async function presentedV1(
  chain: Chain,
  card: IdentityCardV1,
  tracker: ChainTracker | null | undefined,
): Promise<IssuerProfile | IdentityCardRefusal> {
  if (!bapSignatureValid(card)) return 'bap-signature'
  const stored = await rememberConfirmedIssuerIdentityPackage(chain, card.package, tracker)
  const identity = stored?.bapId === card.bapId ? issuerIdentityFor(chain, card.bapId!) : null
  if (!identity) return 'package'
  if (identity.revoked) return 'revoked'
  if (issuerSignerVerdict(identity, card.bapSigner!) !== 'active') return 'signer'
  return profileFromBap(card.identityKey, identity)
}

async function presentedV2(
  chain: Chain,
  card: IdentityCardV2,
  tracker: ChainTracker | null | undefined,
): Promise<IssuerProfile | IdentityCardRefusal> {
  const presents = card.presents!
  if (presents !== card.identityKey && !(await brc3Valid(card, presents, card.presentedSignature!)))
    return 'presented-signature'
  const kept = await rememberIdentityKeyPackage(chain, card.package, tracker)
  if (!kept) return 'profile'
  return identityKeyProfile(chain, presents, kept.bap) ?? 'profile'
}

/**
 * Verify a card and keep it. `expectedIdentityKey` is the authenticated sender
 * when the card came over a sealed envelope; a pasted card stands on its own
 * signatures. A BAP package is header-checked before it reaches the store.
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
  const presents = presentsOf(card)
  const prior = readLinks(chain).links[card.identityKey]
  if (prior) {
    const age = Date.parse(card.issuedAt) - Date.parse(prior.issuedAt)
    if (age < 0 || (age === 0 && !samePresents(prior.presents, presents))) return { kind: 'refused', reason: 'stale' }
  }
  if (!(await brc3Valid(card, card.identityKey, card.identitySignature)))
    return { kind: 'refused', reason: 'identity-signature' }
  if (!presents) {
    writeLink(chain, card.identityKey, { presents: null, issuedAt: card.issuedAt, receivedAt: now })
    return { kind: 'withdrawn', identityKey: card.identityKey }
  }
  const verdict = card.v === 1 ? await presentedV1(chain, card, opts.tracker) : await presentedV2(chain, card, opts.tracker)
  if (typeof verdict === 'string') return { kind: 'refused', reason: verdict }
  writeLink(chain, card.identityKey, { presents, issuedAt: card.issuedAt, receivedAt: now })
  return { kind: 'presented', identityKey: card.identityKey, profile: verdict }
}

/** The profile a wallet key presents to this device, if it still holds. */
export function peerIdentityFor(chain: Chain, identityKey: string | null | undefined): PeerIdentity | null {
  const key = normalizeIssuerIdentityKey(identityKey)
  const presents = key ? readLinks(chain).links[key]?.presents : null
  if (!key || !presents) return null
  if (presents.kind === 'key') {
    const profile = identityKeyProfile(chain, presents.identityKey)
    return profile ? { kind: 'presented', profile } : { kind: 'missing-package', id: presents.identityKey }
  }
  const identity = issuerIdentityFor(chain, presents.bapId)
  if (!identity) return { kind: 'missing-package', id: presents.bapId }
  return identity.revoked ? null : { kind: 'presented', profile: profileFromBap(key, identity) }
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
    case 'presented-signature':
      return 'The presented identity key did not sign this card.'
    case 'profile':
      return 'The card carries no profile that verifies for the presented key.'
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
