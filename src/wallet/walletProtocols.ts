import { PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { COIN_CHAINS, type CoinChain } from './coins/coinChains'
import { durableGetItem, durableSetItem } from './durableStorage'
import { signedIdentityFetch } from './identityRequestAuth'
import type { ActiveWallet } from './session'
import { signIdentityText, verifyIdentityText } from './messageboxAuth'
import { BSV21_PROTOCOL_ID, parseWalletProtocols } from './peerTokenCapability'
import { DEFAULT_METANET_HANDLES_BASE_URL } from './walletConfig'

/**
 * What a wallet can receive, signed by its identity key (BRC-213 §7.2).
 *
 * A sender pays some assets to a key only the recipient's wallet derives:
 * coins on another chain sent to an identity (BRC-213 §7) are spendable only
 * by a wallet that reads the notice and derives the same child key. Sending
 * those to a wallet that cannot is a loss, so the sender asks first.
 *
 * The record is self-verifying; the host is storage. A host can withhold it
 * or serve an older one, never forge one: a missing record refuses the send,
 * and an older record still names only what that wallet once supported.
 */

/** A coin on `chain` sent to this identity is received (BRC-213 §7). */
export const coinProtocolId = (chain: CoinChain): string => `coin:${chain}`

/** What this wallet receives: BSV-21 tips into its token basket and coins of every chain it holds. */
export const WALLET_PROTOCOLS: readonly string[] = [BSV21_PROTOCOL_ID, ...COIN_CHAINS.map(coinProtocolId)]

export type WalletProtocolsRecord = {
  v: 1
  identityKey: string
  protocols: string[]
  at: number
  signature: string
}

const MAX_PROTOCOLS = 64
const REQUEST_TIMEOUT_MS = 8_000
const CACHE_MS = 10 * 60_000

const preimage = (r: Pick<WalletProtocolsRecord, 'identityKey' | 'protocols' | 'at'>): string =>
  JSON.stringify(['wallet-protocols-v1', r.identityKey, r.protocols, r.at])

export function signWalletProtocols(rootKeyHex: string, protocols: readonly string[], at = Date.now()): WalletProtocolsRecord {
  const unsigned = {
    identityKey: PrivateKey.fromHex(rootKeyHex.trim()).toPublicKey().toString().toLowerCase(),
    protocols: parseWalletProtocols([...protocols]).sort(),
    at,
  }
  return { v: 1, ...unsigned, signature: signIdentityText(rootKeyHex, preimage(unsigned)).signature }
}

/** The record for `identityKey`, signed by it, or null. */
export function parseWalletProtocolsRecord(raw: unknown, identityKey: string): WalletProtocolsRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<WalletProtocolsRecord>
  const owner = identityKey.trim().toLowerCase()
  if (r.v !== 1 || r.identityKey !== owner) return null
  if (!Array.isArray(r.protocols) || r.protocols.length > MAX_PROTOCOLS) return null
  if (!r.protocols.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 64)) return null
  if (!Number.isSafeInteger(r.at) || (r.at as number) < 0) return null
  if (typeof r.signature !== 'string') return null
  const record = r as WalletProtocolsRecord
  return verifyIdentityText(owner, preimage(record), record.signature) ? record : null
}

export function walletProtocolsUrl(identityKey: string): string {
  const base = DEFAULT_METANET_HANDLES_BASE_URL.trim().replace(/\/+$/, '')
  return `${base}/v1/identities/${encodeURIComponent(identityKey.trim().toLowerCase())}/protocols.json`
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
}

const publishedKey = (wallet: ActiveWallet) =>
  accountLocalKeyFor(storageRegistry.walletProtocols.key, {
    identityKey: wallet.identityKey,
    accountIndex: wallet.accountIndex ?? 0,
    chain: wallet.chain,
  })

/**
 * Publish this account's record when what it receives changed since it last
 * did. Once per change, never per start; a failure is retried at the next
 * start.
 */
export async function publishWalletProtocols(wallet: ActiveWallet): Promise<'published' | 'current' | 'failed'> {
  const protocols = parseWalletProtocols([...WALLET_PROTOCOLS]).sort()
  const fingerprint = JSON.stringify(protocols)
  if (durableGetItem(publishedKey(wallet)) === fingerprint) return 'current'
  const record = signWalletProtocols(wallet.rootKeyHex, protocols)
  try {
    const res = await signedIdentityFetch(wallet.rootKeyHex, 'protocols', walletProtocolsUrl(record.identityKey), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(record),
      signal: timeoutSignal(),
    })
    if (!res.ok) throw new Error(`protocols publish ${res.status}`)
  } catch (err) {
    console.warn(`[protocols] publish deferred — ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
  durableSetItem(publishedKey(wallet), fingerprint)
  console.info(`[protocols] published ${protocols.join(', ')}`)
  return 'published'
}

export type PeerProtocols =
  | { kind: 'record'; protocols: string[] }
  | { kind: 'absent' }
  | { kind: 'unreachable'; reason: string }

const cache = new Map<string, { at: number; read: PeerProtocols }>()

/** What `identityKey`'s wallet says it receives. A verified record or an answered absence is kept for ten minutes. */
export async function readPeerProtocols(identityKey: string): Promise<PeerProtocols> {
  const key = identityKey.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.read
  let read: PeerProtocols
  try {
    const res = await fetch(walletProtocolsUrl(key), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: timeoutSignal() })
    if (res.status === 404) read = { kind: 'absent' }
    else if (!res.ok) read = { kind: 'unreachable', reason: `protocols read ${res.status}` }
    else {
      const record = parseWalletProtocolsRecord(await res.json().catch(() => null), key)
      read = record ? { kind: 'record', protocols: parseWalletProtocols(record.protocols) } : { kind: 'unreachable', reason: 'protocols record failed verification' }
    }
  } catch (err) {
    read = { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
  }
  if (read.kind !== 'unreachable') cache.set(key, { at: Date.now(), read })
  return read
}

/** Whether a coin on `chain` may be sent to `identityKey`: only when its wallet's signed record says it receives it. */
export type CoinRecipientSupport =
  | { kind: 'supported' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }
  | { kind: 'unreachable'; reason: string }

export async function coinRecipientSupport(identityKey: string, chain: CoinChain): Promise<CoinRecipientSupport> {
  const read = await readPeerProtocols(identityKey)
  if (read.kind === 'unreachable') return read
  if (read.kind === 'absent') return { kind: 'unknown' }
  return read.protocols.includes(coinProtocolId(chain)) ? { kind: 'supported' } : { kind: 'unsupported' }
}

export function resetPeerProtocolsCacheForTest(): void {
  cache.clear()
}
