/**
 * BRC-103/104 mutual authentication for messagebox requests.
 *
 * The first request to a box probes its BRC-104 `/.well-known/auth` handshake
 * through the SDK. A box that completes it gets every later request as a
 * signed BRC-103 general message (the SDK's AuthFetch), and its responses must
 * verify against the identity key it proved. A box that does not speak BRC-104
 * (no `x-bsv-auth-*` headers on its answer: 404, HTML, plain JSON, network or
 * CORS failure) keeps the interim `X-BRC33-*` proof from `messageboxAuth.ts`.
 * A box that claims BRC-104 and fails it is refused, and a box that passed
 * once in this run is never downgraded to the interim proof.
 *
 * The handshake shows the box the account identity key, which the interim
 * headers already send. Nothing else leaves: a box that asks for certificates
 * in the handshake is refused, a later request is answered with none
 * (certificates leave only through BRC-100 `proveCertificate`, behind its
 * approval prompt), and a 402 from a box fails because this wallet cannot
 * create actions.
 *
 * The account key is lent to the session wallet only while one of its
 * requests runs, so cached sessions never hold it.
 */
import {
  AuthFetch,
  Peer,
  PrivateKey,
  ProtoWallet,
  SimplifiedFetchTransport,
  type RequestedCertificateSet,
  type WalletInterface,
} from '@bsv/sdk'
import { logDiag } from './diagnosticLog'

/** BRC-CLOUD's messagebox serves no `/.well-known/auth` yet; probing it would cost every run a failed request. */
const INTERIM_ONLY_HOSTS = new Set(['brc-cloud.bcryderman.workers.dev'])
const INTERIM_RECHECK_MS = 30 * 60_000
const NO_CERTIFICATES: RequestedCertificateSet = { certifiers: [], types: {} }
/** Replaced by the BRC-104 session, or meaningless over it. */
const DROPPED_HEADER = /^(x-brc33-|x-brc103-|accept$)/

type BoxMode = { mode: 'brc104' } | { mode: 'interim'; checkedAt: number }

export class MessageboxPeerRefused extends Error {
  constructor(readonly origin: string, reason: string) {
    super(`BRC-104 messagebox ${origin} refused: ${reason}`)
    this.name = 'MessageboxPeerRefused'
  }
}

class LeasedKeyWallet {
  private key: PrivateKey | null = null
  private leases = 0

  async lease<T>(rootKeyHex: string, run: () => Promise<T>): Promise<T> {
    if (this.leases === 0) this.key = PrivateKey.fromHex(rootKeyHex.trim())
    this.leases++
    try {
      return await run()
    } finally {
      if (--this.leases === 0) this.key = null
    }
  }

  private proto(): ProtoWallet {
    if (!this.key) throw new Error('The messagebox session has no account key outside a request')
    return new ProtoWallet(this.key)
  }

  getPublicKey: WalletInterface['getPublicKey'] = (args) => this.proto().getPublicKey(args)
  createSignature: WalletInterface['createSignature'] = (args) => this.proto().createSignature(args)
  verifySignature: WalletInterface['verifySignature'] = (args) => this.proto().verifySignature(args)
  createHmac: WalletInterface['createHmac'] = (args) => this.proto().createHmac(args)
  verifyHmac: WalletInterface['verifyHmac'] = (args) => this.proto().verifyHmac(args)

  listCertificates: WalletInterface['listCertificates'] = async () => {
    logDiag('messagebox', 'info', 'certificate request declined')
    return { totalCertificates: 0, certificates: [] }
  }

  proveCertificate: WalletInterface['proveCertificate'] = async () => {
    throw new Error('Messagebox sessions reveal no certificates')
  }

  asWallet(): WalletInterface {
    return this as unknown as WalletInterface
  }
}

type Account = { wallet: LeasedKeyWallet; client: AuthFetch }

const accounts = new Map<string, Account>()
const boxes = new Map<string, BoxMode>()
const probes = new Map<string, Promise<BoxMode>>()

const globalFetch: typeof fetch = (input, init) => fetch(input, init)

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountFor(rootKeyHex: string): Account {
  const identityKey = PrivateKey.fromHex(rootKeyHex.trim()).toPublicKey().toString()
  let account = accounts.get(identityKey)
  if (!account) {
    const wallet = new LeasedKeyWallet()
    const client = new AuthFetch(wallet.asWallet(), NO_CERTIFICATES, undefined, undefined, {}, globalFetch)
    account = { wallet, client }
    accounts.set(identityKey, account)
  }
  return account
}

/** The request as AuthFetch can sign it, or null when it must keep the interim proof. */
function brc104Request(url: string, init: RequestInit): {
  origin: string
  config: { method: string; headers: Record<string, string>; body?: string }
} | null {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || INTERIM_ONLY_HOSTS.has(target.host.toLowerCase())) return null
  if (init.body != null && typeof init.body !== 'string') return null
  const headers: Record<string, string> = {}
  for (const [name, value] of new Headers(init.headers)) {
    const key = name.toLowerCase()
    if (DROPPED_HEADER.test(key)) continue
    const signable = key === 'content-type' || key === 'authorization' ||
      (key.startsWith('x-bsv-') && !key.startsWith('x-bsv-auth'))
    if (!signable) return null
    headers[key] = value
  }
  if (init.body != null && !headers['content-type']) return null
  return {
    origin: target.origin,
    config: { method: (init.method || 'GET').toUpperCase(), headers, body: init.body ?? undefined },
  }
}

async function probe(wallet: LeasedKeyWallet, origin: string): Promise<BoxMode> {
  let claimed = false
  const watched: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    response.headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith('x-bsv-auth')) claimed = true
    })
    return response
  }
  const peer = new Peer(wallet.asWallet(), new SimplifiedFetchTransport(origin, watched), NO_CERTIFICATES)
  let asksForCertificates = false
  peer.listenForCertificatesRequested(() => {
    asksForCertificates = true
  })
  await peer.ready
  try {
    await peer.getAuthenticatedSession()
  } catch (error) {
    if (!claimed) return { mode: 'interim', checkedAt: Date.now() }
    logDiag('messagebox', 'warn', 'BRC-104 handshake refused', { origin, reason: reason(error) })
    throw new MessageboxPeerRefused(origin, reason(error))
  }
  if (asksForCertificates) {
    logDiag('messagebox', 'warn', 'BRC-104 box asked for certificates', { origin })
    throw new MessageboxPeerRefused(origin, 'it asks for identity certificates, which messagebox sessions never reveal')
  }
  return { mode: 'brc104' }
}

async function boxMode(wallet: LeasedKeyWallet, origin: string): Promise<BoxMode> {
  const known = boxes.get(origin)
  if (known?.mode === 'brc104') return known
  if (known && Date.now() - known.checkedAt < INTERIM_RECHECK_MS) return known
  let pending = probes.get(origin)
  if (!pending) {
    pending = probe(wallet, origin).finally(() => probes.delete(origin))
    probes.set(origin, pending)
  }
  const found = await pending
  if (boxes.get(origin)?.mode !== 'brc104') boxes.set(origin, found)
  return boxes.get(origin)!
}

/**
 * Send a messagebox request over BRC-104 when the box speaks it, else through
 * `interim` (the caller's request with its `X-BRC33-*` proof).
 */
export async function messageboxPeerFetch(
  rootKeyHex: string,
  url: string,
  init: RequestInit,
  interim: () => Promise<Response>,
): Promise<Response> {
  const request = brc104Request(url, init)
  if (!request) return interim()
  const { wallet, client } = accountFor(rootKeyHex)
  const response = await wallet.lease(rootKeyHex, async () => {
    const { mode } = await boxMode(wallet, request.origin)
    if (mode === 'interim') return null
    try {
      return (await client.fetch(url, request.config)) as Response
    } catch (error) {
      logDiag('messagebox', 'warn', 'BRC-104 request refused', { origin: request.origin, reason: reason(error) })
      throw new MessageboxPeerRefused(request.origin, reason(error))
    }
  })
  return response ?? interim()
}

/** Forget box modes and sessions (tests). */
export function resetMessageboxPeerAuth(): void {
  accounts.clear()
  boxes.clear()
  probes.clear()
}
