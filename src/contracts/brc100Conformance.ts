import { BigNumber, ECDSA, Hash, PublicKey, Signature, Utils, type WalletInterface } from '@bsv/sdk'
import {
  ANYONE_PRIVATE_KEY_HEX,
  ANYONE_PUBLIC_KEY_HEX,
  KEY_ID_MAX,
  PROTOCOL_NAME_MAX,
  brc2SymmetricKey,
  brc43Invoice,
  childPrivateKey,
  childPublicKey,
  invoiceLinkage,
  invoiceOrThrow,
  offsetPublicKey,
  publicKeyOf,
  sharedSecret,
  type InvoiceRefusal,
  type ProtocolID,
} from './bkdsReference'

/**
 * BRC-100 key-derivation conformance, black box.
 *
 * Every check talks to a wallet only through `WalletInterface` and judges the
 * answer with `bkdsReference` plus keys the suite itself holds: a peer (Bob)
 * whose private key lets the suite rebuild what a counterparty would derive,
 * a verifier for linkage revelations, and `anyone` (private key 1). Nothing is
 * read from the wallet's internals, so the same checks run against the SDK's
 * ProtoWallet, HandCash's bridge in-process, or any wallet listening on the
 * BRC-100 HTTP substrate.
 *
 * Profiles:
 * - `wallet`: what every BRC-100 wallet owes every caller.
 * - `app-boundary`: what a wallet owes when the caller is an application
 *   (BRC-44 admin protocols, BRC-98 permission schemes). A raw key wallet used
 *   by the client itself is not judged on these.
 */

export type ConformanceProfile = 'wallet' | 'app-boundary'

export type ConformanceOptions = {
  /** Originator passed on every call (the app domain under test). */
  originator?: string
  profiles?: readonly ConformanceProfile[]
  /** BRC-98 scheme ids the wallet declares it supports; any other `p <scheme>` must be refused. */
  supportedPermissionSchemes?: readonly string[]
  /** Security levels exercised by the derivation checks. Levels 1 and 2 prompt on wallets with permissions. */
  securityLevels?: readonly (0 | 1 | 2)[]
}

export type ConformanceContext = {
  wallet: WalletInterface
  originator?: string
  identityKey: string
  levels: readonly (0 | 1 | 2)[]
  supportedPermissionSchemes: readonly string[]
}

export type ConformanceCheck = {
  id: string
  brc: string
  profile: ConformanceProfile
  title: string
  run: (ctx: ConformanceContext) => Promise<void>
}

export type ConformanceResult = {
  id: string
  brc: string
  title: string
  ok: boolean
  reason?: string
  ms: number
}

/** Bob: the counterparty whose side the suite computes. Fixed so failures reproduce. */
export const PEER_PRIVATE_KEY = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
export const PEER_PUBLIC_KEY = publicKeyOf(PEER_PRIVATE_KEY)
/** Victor: receives linkage revelations. */
export const VERIFIER_PRIVATE_KEY = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1'
export const VERIFIER_PUBLIC_KEY = publicKeyOf(VERIFIER_PRIVATE_KEY)

const PROTOCOL = 'brc conformance'
const KEY_ID = 'conformance-1'
const BRC29_PROTOCOL: ProtocolID = [2, '3241645161d8']
const DATA = Utils.toArray('BRC-100 conformance', 'utf8')
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

class ConformanceFailure extends Error {}

function fail(message: string): never {
  throw new ConformanceFailure(message)
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) fail(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

function expectKey(value: unknown, what: string): string {
  const key = String(value ?? '').toLowerCase()
  if (!COMPRESSED_KEY.test(key)) fail(`${what} is not a compressed public key: ${String(value)}`)
  return key
}

/** Resolves when the wallet refused; fails the check when it answered. */
async function expectRefusal(call: () => Promise<unknown>, what: string): Promise<void> {
  let answered: unknown
  try {
    answered = await call()
  } catch {
    return
  }
  fail(`${what} was answered instead of refused: ${JSON.stringify(answered)?.slice(0, 120)}`)
}

/** verify* methods may refuse by throwing or by answering `valid: false`. */
async function expectInvalid(call: () => Promise<{ valid?: boolean }>, what: string): Promise<void> {
  let result: { valid?: boolean }
  try {
    result = await call()
  } catch {
    return
  }
  if (result?.valid !== false) fail(`${what} was accepted`)
}

function bytes(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || value.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    fail(`${what} is not a byte array`)
  }
  return value as number[]
}

function verifyEcdsa(publicKeyHex: string, digest: number[], der: number[]): boolean {
  return ECDSA.verify(new BigNumber(digest), Signature.fromDER(der), PublicKey.fromString(publicKeyHex))
}

async function publicKey(ctx: ConformanceContext, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.wallet.getPublicKey(args as never, ctx.originator)
  return expectKey(result?.publicKey, `getPublicKey(${JSON.stringify(args)})`)
}

/** The wallet's own child for `counterparty`, as the counterparty rebuilds it. */
function ownChildSeenByPeer(ctx: ConformanceContext, peerPrivateKey: string, invoiceNumber: string): string {
  return childPublicKey({ senderPrivateKey: peerPrivateKey, recipientPublicKey: ctx.identityKey, invoiceNumber })
}

/** The counterparty's child the wallet derives for it, as the counterparty rebuilds it. */
function peerChildSeenByPeer(ctx: ConformanceContext, peerPrivateKey: string, invoiceNumber: string): string {
  return publicKeyOf(childPrivateKey({ recipientPrivateKey: peerPrivateKey, senderPublicKey: ctx.identityKey, invoiceNumber }))
}

function protocolAt(level: 0 | 1 | 2, name = PROTOCOL): ProtocolID {
  return [level, name]
}

const INVALID_INVOICES: { refusal: InvoiceRefusal; protocolID: [number, string]; keyID: string }[] = [
  { refusal: 'security-level', protocolID: [3, PROTOCOL], keyID: KEY_ID },
  { refusal: 'security-level', protocolID: [-1, PROTOCOL], keyID: KEY_ID },
  { refusal: 'protocol-too-short', protocolID: [0, 'abcd'], keyID: KEY_ID },
  { refusal: 'protocol-too-long', protocolID: [0, 'a'.repeat(PROTOCOL_NAME_MAX + 1)], keyID: KEY_ID },
  { refusal: 'protocol-double-space', protocolID: [0, 'brc  conformance'], keyID: KEY_ID },
  { refusal: 'protocol-charset', protocolID: [0, 'brc-conformance'], keyID: KEY_ID },
  { refusal: 'protocol-charset', protocolID: [0, 'brc_conformance'], keyID: KEY_ID },
  { refusal: 'protocol-suffix', protocolID: [0, 'conformance protocol'], keyID: KEY_ID },
  { refusal: 'key-id-empty', protocolID: [0, PROTOCOL], keyID: '' },
  { refusal: 'key-id-too-long', protocolID: [0, PROTOCOL], keyID: 'k'.repeat(KEY_ID_MAX + 1) },
]

const KEY_METHOD_PROBES: { method: string; args: Record<string, unknown> }[] = [
  { method: 'getPublicKey', args: { counterparty: 'self' } },
  { method: 'createSignature', args: { counterparty: 'self', data: DATA } },
  { method: 'encrypt', args: { counterparty: 'self', plaintext: DATA } },
  { method: 'createHmac', args: { counterparty: 'self', data: DATA } },
]

async function probe(ctx: ConformanceContext, method: string, args: Record<string, unknown>): Promise<unknown> {
  const fn = (ctx.wallet as unknown as Record<string, (a: unknown, o?: string) => Promise<unknown>>)[method]
  return fn.call(ctx.wallet, args, ctx.originator)
}

export const BRC100_CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'identity-key',
    brc: 'BRC-100 getPublicKey',
    profile: 'wallet',
    title: 'identityKey: true answers one compressed key and overrides protocol, key ID and counterparty',
    async run(ctx) {
      const plain = await publicKey(ctx, { identityKey: true })
      expectEqual(plain, ctx.identityKey, 'identity key is stable')
      const overridden = await publicKey(ctx, {
        identityKey: true,
        protocolID: protocolAt(0),
        keyID: KEY_ID,
        counterparty: PEER_PUBLIC_KEY,
      })
      expectEqual(overridden, ctx.identityKey, 'identityKey: true overrides derivation arguments')
    },
  },
  {
    id: 'anyone-self-child',
    brc: 'BRC-42 / BRC-43 anyone',
    profile: 'wallet',
    title: 'counterparty anyone, forSelf: the wallet child anyone can rebuild with private key 1',
    async run(ctx) {
      for (const level of ctx.levels) {
        const invoiceNumber = invoiceOrThrow(protocolAt(level), KEY_ID)
        const got = await publicKey(ctx, { protocolID: protocolAt(level), keyID: KEY_ID, counterparty: 'anyone', forSelf: true })
        expectEqual(got, ownChildSeenByPeer(ctx, ANYONE_PRIVATE_KEY_HEX, invoiceNumber), `level ${level} invoice "${invoiceNumber}"`)
      }
    },
  },
  {
    id: 'anyone-peer-child',
    brc: 'BRC-42 / BRC-43 anyone',
    profile: 'wallet',
    title: 'counterparty anyone, not forSelf: the child of G, keyed by the wallet identity',
    async run(ctx) {
      const invoiceNumber = invoiceOrThrow(protocolAt(0), KEY_ID)
      const got = await publicKey(ctx, { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: 'anyone' })
      expectEqual(got, peerChildSeenByPeer(ctx, ANYONE_PRIVATE_KEY_HEX, invoiceNumber), 'anyone child')
      if (got === ANYONE_PUBLIC_KEY_HEX) fail('returned G itself instead of a derived child')
    },
  },
  {
    id: 'peer-children',
    brc: 'BRC-42',
    profile: 'wallet',
    title: 'counterparty key: both children match what the counterparty derives from its own private key',
    async run(ctx) {
      for (const level of ctx.levels) {
        const invoiceNumber = invoiceOrThrow(protocolAt(level), KEY_ID)
        const theirs = await publicKey(ctx, { protocolID: protocolAt(level), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY })
        expectEqual(theirs, peerChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), `level ${level} counterparty child`)
        const mine = await publicKey(ctx, { protocolID: protocolAt(level), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY, forSelf: true })
        expectEqual(mine, ownChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), `level ${level} own child`)
      }
    },
  },
  {
    id: 'self-is-identity',
    brc: 'BRC-43 self',
    profile: 'wallet',
    title: 'counterparty self derives with the wallet identity key on both sides, and is the default',
    async run(ctx) {
      const args = { protocolID: protocolAt(0), keyID: KEY_ID }
      const self = await publicKey(ctx, { ...args, counterparty: 'self', forSelf: true })
      const explicit = await publicKey(ctx, { ...args, counterparty: ctx.identityKey, forSelf: true })
      expectEqual(self, explicit, 'self equals the identity key as counterparty')
      const byDefault = await publicKey(ctx, args)
      expectEqual(byDefault, self, 'getPublicKey counterparty defaults to self')
    },
  },
  {
    id: 'never-root',
    brc: 'BRC-42 / BRC-100',
    profile: 'wallet',
    title: 'a derivation request never answers the identity (root) key',
    async run(ctx) {
      for (const counterparty of ['self', 'anyone', PEER_PUBLIC_KEY]) {
        for (const forSelf of [false, true]) {
          const got = await publicKey(ctx, { protocolID: protocolAt(0), keyID: KEY_ID, counterparty, forSelf })
          if (got === ctx.identityKey) fail(`counterparty ${counterparty} forSelf ${forSelf} returned the root key`)
        }
      }
    },
  },
  {
    id: 'identity-address-unsignable',
    brc: 'BRC-42 / BRC-100',
    profile: 'wallet',
    title: 'no signing request yields a root-key signature: an output paid to the identity address is unspendable over BRC-100',
    async run(ctx) {
      const digest = Hash.sha256(DATA)
      for (const level of ctx.levels) {
        for (const counterparty of ['self', 'anyone', PEER_PUBLIC_KEY]) {
          const { signature } = await ctx.wallet.createSignature(
            { protocolID: protocolAt(level), keyID: KEY_ID, counterparty, hashToDirectlySign: digest },
            ctx.originator,
          )
          if (verifyEcdsa(ctx.identityKey, digest, bytes(signature, 'signature'))) {
            fail(`level ${level} counterparty ${counterparty} signed with the identity key`)
          }
        }
      }
    },
  },
  {
    id: 'security-level-in-invoice',
    brc: 'BRC-43 invoice',
    profile: 'wallet',
    title: 'the security level is part of the invoice: levels 0, 1 and 2 give three keys',
    async run(ctx) {
      if (ctx.levels.length < 2) return
      const keys = new Set<string>()
      for (const level of ctx.levels) {
        keys.add(await publicKey(ctx, { protocolID: protocolAt(level), keyID: KEY_ID, counterparty: 'anyone', forSelf: true }))
      }
      expectEqual(keys.size, ctx.levels.length, 'distinct keys per security level')
    },
  },
  {
    id: 'protocol-normalisation',
    brc: 'BRC-43 rules',
    profile: 'wallet',
    title: 'protocol names normalise (case, outer spaces) to one key; key IDs are not normalised',
    async run(ctx) {
      const base = await publicKey(ctx, { protocolID: [0, PROTOCOL], keyID: KEY_ID, counterparty: 'anyone', forSelf: true })
      for (const variant of ['BRC Conformance', '  brc conformance  ', 'BRC CONFORMANCE ']) {
        const got = await publicKey(ctx, { protocolID: [0, variant], keyID: KEY_ID, counterparty: 'anyone', forSelf: true })
        expectEqual(got, base, `protocol "${variant}"`)
      }
      const upperKey = await publicKey(ctx, { protocolID: [0, PROTOCOL], keyID: KEY_ID.toUpperCase(), counterparty: 'anyone', forSelf: true })
      if (upperKey === base) fail('key ID was case-folded')
      const spacedKey = await publicKey(ctx, { protocolID: [0, PROTOCOL], keyID: ` ${KEY_ID}`, counterparty: 'anyone', forSelf: true })
      if (spacedKey === base) fail('key ID was trimmed')
    },
  },
  {
    id: 'utf8-key-id',
    brc: 'BRC-42 invoice',
    profile: 'wallet',
    title: 'the invoice number is hashed as UTF-8',
    async run(ctx) {
      const keyID = 'ключ ✓ 鍵'
      const invoiceNumber = invoiceOrThrow(protocolAt(0), keyID)
      const got = await publicKey(ctx, { protocolID: protocolAt(0), keyID, counterparty: PEER_PUBLIC_KEY })
      expectEqual(got, peerChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), 'UTF-8 key ID child')
    },
  },
  {
    id: 'bounds-accepted',
    brc: 'BRC-100 ProtocolString5To400 / KeyIDUnder800',
    profile: 'wallet',
    title: 'the longest and shortest legal names and key IDs derive the expected keys',
    async run(ctx) {
      const cases: [ProtocolID, string][] = [
        [[0, 'abcde'], 'k'],
        [[0, 'a'.repeat(PROTOCOL_NAME_MAX)], KEY_ID],
        [[0, PROTOCOL], 'k'.repeat(KEY_ID_MAX)],
      ]
      for (const [protocolID, keyID] of cases) {
        const invoiceNumber = invoiceOrThrow(protocolID, keyID)
        const got = await publicKey(ctx, { protocolID, keyID, counterparty: PEER_PUBLIC_KEY })
        expectEqual(got, peerChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), `name ${protocolID[1].length} / key ID ${keyID.length}`)
      }
    },
  },
  {
    id: 'invalid-invoices-refused',
    brc: 'BRC-43 rules / BRC-100',
    profile: 'wallet',
    title: 'every invoice that breaks a BRC-43 rule is refused, never silently repaired',
    async run(ctx) {
      for (const { refusal, protocolID, keyID } of INVALID_INVOICES) {
        const reference = brc43Invoice(protocolID, keyID)
        if (reference.ok || reference.refusal !== refusal) fail(`reference disagrees on ${refusal}`)
        await expectRefusal(
          () => ctx.wallet.getPublicKey({ protocolID: protocolID as never, keyID, counterparty: 'self' }, ctx.originator),
          `${refusal} (${JSON.stringify(protocolID).slice(0, 60)}, key ID length ${keyID.length})`,
        )
      }
    },
  },
  {
    id: 'brc29-payment-key',
    brc: 'BRC-29',
    profile: 'wallet',
    title: 'a BRC-29 payer derives the payee key the payee can spend',
    async run(ctx) {
      const keyID = 'cHJlZml4 c3VmZml4'
      const invoiceNumber = invoiceOrThrow(BRC29_PROTOCOL, keyID)
      expectEqual(invoiceNumber, '2-3241645161d8-cHJlZml4 c3VmZml4', 'BRC-29 invoice')
      const got = await publicKey(ctx, { protocolID: BRC29_PROTOCOL, keyID, counterparty: PEER_PUBLIC_KEY })
      expectEqual(got, peerChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), 'payee key')
    },
  },
  {
    id: 'signature-anyone-default',
    brc: 'BRC-3',
    profile: 'wallet',
    title: 'createSignature defaults to anyone and signs SHA-256(data) with the key anyone can rebuild',
    async run(ctx) {
      const invoiceNumber = invoiceOrThrow(protocolAt(0), KEY_ID)
      const { signature } = await ctx.wallet.createSignature({ protocolID: protocolAt(0), keyID: KEY_ID, data: DATA }, ctx.originator)
      const signer = ownChildSeenByPeer(ctx, ANYONE_PRIVATE_KEY_HEX, invoiceNumber)
      if (!verifyEcdsa(signer, Hash.sha256(DATA), bytes(signature, 'signature'))) {
        fail('signature does not verify against the anyone-derivable child key')
      }
    },
  },
  {
    id: 'signature-peer',
    brc: 'BRC-3',
    profile: 'wallet',
    title: 'a signature for a counterparty verifies only with the key that counterparty rebuilds',
    async run(ctx) {
      const invoiceNumber = invoiceOrThrow(protocolAt(0), KEY_ID)
      const digest = Hash.sha256(DATA)
      const { signature } = await ctx.wallet.createSignature(
        { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY, hashToDirectlySign: digest },
        ctx.originator,
      )
      const der = bytes(signature, 'signature')
      if (!verifyEcdsa(ownChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), digest, der)) {
        fail('hashToDirectlySign signature does not verify for the counterparty')
      }
      if (verifyEcdsa(ctx.identityKey, digest, der)) fail('signed with the root key')
    },
  },
  {
    id: 'signature-verify',
    brc: 'BRC-3',
    profile: 'wallet',
    title: 'verifySignature accepts its own signature (forSelf) and refuses tampered data',
    async run(ctx) {
      const args = { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY }
      const { signature } = await ctx.wallet.createSignature({ ...args, data: DATA }, ctx.originator)
      const ok = await ctx.wallet.verifySignature({ ...args, forSelf: true, data: DATA, signature }, ctx.originator)
      expectEqual(ok?.valid, true, 'own signature verifies with forSelf')
      await expectInvalid(
        () => ctx.wallet.verifySignature({ ...args, forSelf: true, data: [...DATA, 0], signature }, ctx.originator),
        'signature over tampered data',
      )
    },
  },
  {
    id: 'encryption-interop',
    brc: 'BRC-2',
    profile: 'wallet',
    title: 'encryption for a counterparty decrypts on its side, and the wallet decrypts what it sends back',
    async run(ctx) {
      const invoiceNumber = invoiceOrThrow(protocolAt(0), KEY_ID)
      const peerKey = brc2SymmetricKey({ ownPrivateKey: PEER_PRIVATE_KEY, peerPublicKey: ctx.identityKey, invoiceNumber })
      const args = { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY }
      const { ciphertext } = await ctx.wallet.encrypt({ ...args, plaintext: DATA }, ctx.originator)
      let opened: number[]
      try {
        opened = peerKey.decrypt(bytes(ciphertext, 'ciphertext')) as number[]
      } catch {
        fail('counterparty cannot decrypt with the BRC-2 key it derives')
      }
      expectEqual(Utils.toHex(opened), Utils.toHex(DATA), 'plaintext at the counterparty')
      const reply = Utils.toArray('reply', 'utf8')
      const { plaintext } = await ctx.wallet.decrypt({ ...args, ciphertext: peerKey.encrypt(reply) as number[] }, ctx.originator)
      expectEqual(Utils.toHex(bytes(plaintext, 'plaintext')), Utils.toHex(reply), 'wallet decrypts the counterparty reply')
    },
  },
  {
    id: 'encryption-self',
    brc: 'BRC-2',
    profile: 'wallet',
    title: 'encrypt defaults to self, round-trips, and refuses a different key ID',
    async run(ctx) {
      const { ciphertext } = await ctx.wallet.encrypt({ protocolID: protocolAt(0), keyID: KEY_ID, plaintext: DATA }, ctx.originator)
      const { plaintext } = await ctx.wallet.decrypt(
        { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: 'self', ciphertext },
        ctx.originator,
      )
      expectEqual(Utils.toHex(bytes(plaintext, 'plaintext')), Utils.toHex(DATA), 'self round trip')
      await expectRefusal(
        () => ctx.wallet.decrypt({ protocolID: protocolAt(0), keyID: `${KEY_ID}x`, ciphertext }, ctx.originator),
        'decrypt under another key ID',
      )
    },
  },
  {
    id: 'hmac-interop',
    brc: 'BRC-56',
    profile: 'wallet',
    title: 'HMAC uses the BRC-2 symmetric key: the counterparty computes the same tag',
    async run(ctx) {
      const invoiceNumber = invoiceOrThrow(protocolAt(0), KEY_ID)
      const peerKey = brc2SymmetricKey({ ownPrivateKey: PEER_PRIVATE_KEY, peerPublicKey: ctx.identityKey, invoiceNumber })
      const args = { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: PEER_PUBLIC_KEY }
      const { hmac } = await ctx.wallet.createHmac({ ...args, data: DATA }, ctx.originator)
      expectEqual(Utils.toHex(bytes(hmac, 'hmac')), Utils.toHex(Hash.sha256hmac(peerKey.toArray(), DATA)), 'HMAC tag')
      const ok = await ctx.wallet.verifyHmac({ ...args, data: DATA, hmac }, ctx.originator)
      expectEqual(ok?.valid, true, 'verifyHmac accepts its own tag')
      await expectInvalid(() => ctx.wallet.verifyHmac({ ...args, data: [...DATA, 1], hmac }, ctx.originator), 'HMAC over tampered data')
    },
  },
  {
    id: 'specific-linkage',
    brc: 'BRC-69 / BRC-72',
    profile: 'wallet',
    title: 'a specific linkage, opened by the verifier, rebuilds exactly the wallet child for that invoice',
    async run(ctx) {
      const protocolID = protocolAt(0)
      const invoiceNumber = invoiceOrThrow(protocolID, KEY_ID)
      const revealed = await ctx.wallet.revealSpecificKeyLinkage(
        { counterparty: PEER_PUBLIC_KEY, verifier: VERIFIER_PUBLIC_KEY, protocolID, keyID: KEY_ID },
        ctx.originator,
      )
      expectEqual(String(revealed?.prover).toLowerCase(), ctx.identityKey, 'prover')
      expectEqual(String(revealed?.counterparty).toLowerCase(), PEER_PUBLIC_KEY, 'counterparty')
      const revelationInvoice = invoiceOrThrow([2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`], KEY_ID)
      const key = brc2SymmetricKey({ ownPrivateKey: VERIFIER_PRIVATE_KEY, peerPublicKey: ctx.identityKey, invoiceNumber: revelationInvoice })
      let linkage: number[]
      try {
        linkage = key.decrypt(bytes(revealed?.encryptedLinkage, 'encryptedLinkage')) as number[]
      } catch {
        fail('verifier cannot open the linkage with the BRC-72 revelation key')
      }
      const expected = invoiceLinkage(sharedSecret(PEER_PRIVATE_KEY, ctx.identityKey), invoiceNumber)
      expectEqual(Utils.toHex(linkage), Utils.toHex(expected), 'linkage is the BRC-42 HMAC for the invoice')
      expectEqual(offsetPublicKey(ctx.identityKey, linkage), ownChildSeenByPeer(ctx, PEER_PRIVATE_KEY, invoiceNumber), 'identity + G·linkage')
    },
  },
  {
    id: 'counterparty-linkage',
    brc: 'BRC-69 / BRC-72',
    profile: 'wallet',
    title: 'a counterparty linkage, opened by the verifier, is the ECDH shared secret',
    async run(ctx) {
      const revealed = await ctx.wallet.revealCounterpartyKeyLinkage(
        { counterparty: PEER_PUBLIC_KEY, verifier: VERIFIER_PUBLIC_KEY },
        ctx.originator,
      )
      expectEqual(String(revealed?.prover).toLowerCase(), ctx.identityKey, 'prover')
      const revelationTime = String(revealed?.revelationTime ?? '')
      if (!revelationTime) fail('no revelationTime')
      const revelationInvoice = invoiceOrThrow([2, 'counterparty linkage revelation'], revelationTime)
      const key = brc2SymmetricKey({ ownPrivateKey: VERIFIER_PRIVATE_KEY, peerPublicKey: ctx.identityKey, invoiceNumber: revelationInvoice })
      let linkage: number[]
      try {
        linkage = key.decrypt(bytes(revealed?.encryptedLinkage, 'encryptedLinkage')) as number[]
      } catch {
        fail('verifier cannot open the counterparty linkage')
      }
      const expected = sharedSecret(PEER_PRIVATE_KEY, ctx.identityKey).encode(true) as number[]
      expectEqual(Utils.toHex(linkage), Utils.toHex(expected), 'linkage is the compressed shared secret')
    },
  },
  {
    id: 'privileged-never-everyday',
    brc: 'BRC-100 privileged mode',
    profile: 'wallet',
    title: 'a privileged request is served by the privileged keyring or refused, never by the everyday root',
    async run(ctx) {
      const args = { protocolID: protocolAt(0), keyID: KEY_ID, counterparty: 'anyone', forSelf: true }
      const everyday = await publicKey(ctx, args)
      let privileged: string
      try {
        privileged = await publicKey(ctx, { ...args, privileged: true, privilegedReason: 'Conformance check' })
      } catch {
        return
      }
      if (privileged === everyday) fail('privileged request answered with the everyday key')
    },
  },
  {
    id: 'admin-protocols-refused',
    brc: 'BRC-44',
    profile: 'app-boundary',
    title: 'protocols starting with "admin" are refused to applications at every security level',
    async run(ctx) {
      for (const name of ['admin conformance', '  Admin Conformance', 'administrator keys']) {
        for (const level of [0, 1, 2] as const) {
          for (const { method, args } of KEY_METHOD_PROBES) {
            await expectRefusal(
              () => probe(ctx, method, { ...args, protocolID: [level, name], keyID: KEY_ID }),
              `${method} [${level}, "${name}"]`,
            )
          }
        }
      }
    },
  },
  {
    id: 'permission-schemes-refused',
    brc: 'BRC-98',
    profile: 'app-boundary',
    title: '"p <scheme>" protocols are refused unless the wallet supports that scheme',
    async run(ctx) {
      for (const scheme of ['nosuchscheme', 'color', 'basket']) {
        if (ctx.supportedPermissionSchemes.includes(scheme)) continue
        const name = `p ${scheme} conformance`
        for (const { method, args } of KEY_METHOD_PROBES) {
          await expectRefusal(() => probe(ctx, method, { ...args, protocolID: [2, name], keyID: KEY_ID }), `${method} [2, "${name}"]`)
        }
      }
    },
  },
]

export function conformanceChecks(profiles: readonly ConformanceProfile[] = ['wallet']): ConformanceCheck[] {
  return BRC100_CONFORMANCE_CHECKS.filter((check) => profiles.includes(check.profile))
}

export async function conformanceContext(wallet: WalletInterface, opts: ConformanceOptions = {}): Promise<ConformanceContext> {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, opts.originator)
  return {
    wallet,
    originator: opts.originator,
    identityKey: expectKey(identityKey, 'identity key'),
    levels: opts.securityLevels ?? [0, 1, 2],
    supportedPermissionSchemes: opts.supportedPermissionSchemes ?? [],
  }
}

export async function runConformanceCheck(check: ConformanceCheck, ctx: ConformanceContext): Promise<ConformanceResult> {
  const started = Date.now()
  try {
    await check.run(ctx)
    return { id: check.id, brc: check.brc, title: check.title, ok: true, ms: Date.now() - started }
  } catch (err) {
    const reason = err instanceof ConformanceFailure ? err.message : `threw: ${err instanceof Error ? err.message : String(err)}`
    return { id: check.id, brc: check.brc, title: check.title, ok: false, reason, ms: Date.now() - started }
  }
}

export async function runBrc100Conformance(wallet: WalletInterface, opts: ConformanceOptions = {}): Promise<ConformanceResult[]> {
  const ctx = await conformanceContext(wallet, opts)
  const results: ConformanceResult[] = []
  for (const check of conformanceChecks(opts.profiles)) results.push(await runConformanceCheck(check, ctx))
  return results
}

export function formatConformanceReport(results: readonly ConformanceResult[]): string {
  const failed = results.filter((r) => !r.ok)
  const lines = results.map((r) => `${r.ok ? 'pass' : 'FAIL'}  ${r.id.padEnd(28)} ${r.brc}${r.ok ? '' : `\n      ${r.reason}`}`)
  lines.push('', `${results.length - failed.length}/${results.length} checks pass`)
  return lines.join('\n')
}
