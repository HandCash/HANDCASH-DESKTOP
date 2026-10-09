import { PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { getFriendByIdentityKey, type Friend } from './friends'
import {
  IDENTITY_CARD_REQUEST,
  identityCardFromWire,
  identityCardWire,
  isIdentityCardControl,
  rememberIdentityCard,
  signIdentityCard,
  type IdentityCard,
  type IdentityCardOutcome,
} from './identityCard'
import {
  MESSAGEBOX_INNER_MAX,
  deliverOutbound,
  deliveryReachedPeer,
  type OutboundEnvelope,
} from './messageTransport'
import { presentedIdentityMaterial, presentedIdentityOfAccount } from './publicIdentities'
import type { IssuerIdentity } from './issuerIdentity'
import type { Chain } from './vault'
import { findVaultAccountByIdentityKey } from './vaultAccounts'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'
import { getWalletRuntime, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

/**
 * Identity cards ride the same sealed peer channel as chat: the direct IPv6
 * session when one is live, otherwise the recipient's BRC-33 box. A card goes
 * to a contact this wallet just reached, once per card version, and a contact
 * can ask for it again. The other accounts of this vault count as contacts:
 * a subwallet need not add its own primary back to share its card. Market
 * counterparties and strangers never get one unasked. No card ever gates the
 * delivery it follows.
 */

type OwnCard = { owner: string; version: string; card: IdentityCard; fits: boolean }

const REQUEST_INTERVAL_MS = 10 * 60 * 1000
const MAX_SENT = 1024
const SLOW_MS = 250

let own: OwnCard | null = null
const lastRequested = new Map<string, number>()
const lastAnswered = new Map<string, number>()
const inFlight = new Map<string, Promise<boolean>>()

function currentRuntime(): WalletRuntime | null {
  const runtime = getWalletRuntime()
  return runtime && runtimeIsCurrent(runtime) ? runtime : null
}

let masterIdentity: { master: VaultMaster; identityKey: string } | null = null

function masterIdentityKeyOf(master: VaultMaster): string {
  if (masterIdentity?.master !== master) {
    masterIdentity = { master, identityKey: vaultIdentityKey(master) }
  }
  return masterIdentity.identityKey
}

/** Another account of this wallet's vault, derived from the same master. */
function siblingAccount(runtime: WalletRuntime, peer: string) {
  const active = runtime.instance
  if (peer === active.identityKey.toLowerCase()) return null
  try {
    return findVaultAccountByIdentityKey(masterIdentityKeyOf(active.vaultMaster), peer)
  } catch {
    return null
  }
}

/** Who may get our card unasked or on request: a contact, or a sibling account. */
function knownPeer(runtime: WalletRuntime, peer: string): Pick<Friend, 'identityKey' | 'messagebox'> | null {
  const friend = getFriendByIdentityKey(peer)
  if (friend) return friend
  return siblingAccount(runtime, peer) ? { identityKey: peer, messagebox: null } : null
}

/**
 * The identity a sibling account presents, read on this device without a
 * card: it is this wallet's own published identity.
 */
export function siblingAccountIdentity(chain: Chain, identityKey: string | null | undefined): IssuerIdentity | null {
  const runtime = currentRuntime()
  const peer = identityKey?.trim().toLowerCase()
  if (!runtime || !peer) return null
  const sibling = siblingAccount(runtime, peer)
  if (!sibling) return null
  return presentedIdentityOfAccount({ identityKey: sibling.identityKey, accountIndex: sibling.index, chain })
}

function sentKey(runtime: WalletRuntime): string {
  const active = runtime.instance
  return accountLocalKeyFor(storageRegistry.identityCardsSent.key, {
    identityKey: active.identityKey,
    accountIndex: active.accountIndex ?? 0,
    chain: active.chain,
  })
}

function readSent(runtime: WalletRuntime): Record<string, string> {
  try {
    const parsed = JSON.parse(durableGetItem(sentKey(runtime)) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function recordSent(runtime: WalletRuntime, peer: string, version: string): void {
  const { [peer]: _prior, ...rest } = readSent(runtime)
  const entries = Object.entries(rest)
  durableSetItem(
    sentKey(runtime),
    JSON.stringify(Object.fromEntries([...entries.slice(Math.max(0, entries.length - MAX_SENT + 1)), [peer, version]])),
  )
}

/** This wallet's card as it stands now, signed once per version. */
async function ownCard(runtime: WalletRuntime): Promise<OwnCard | null> {
  const material = presentedIdentityMaterial(runtime)
  if (!material) return null
  const owner = runtime.instance.identityKey.toLowerCase()
  const version =
    material.kind === 'presented'
      ? [
          material.identity.bapId,
          material.issuedAt,
          material.identity.alias.txid,
          material.signingKey.toPublicKey().toString(),
          material.pkg.beefB64.length,
        ].join(':')
      : `none:${material.issuedAt}`
  if (own?.owner === owner && own.version === version) return own
  const card = await signIdentityCard({
    rootKeyHex: runtime.instance.rootKeyHex,
    issuedAt: material.issuedAt,
    presented: material.kind === 'presented' ? { pkg: material.pkg, signingKey: material.signingKey } : undefined,
  })
  const fits = identityCardWire(card).length <= MESSAGEBOX_INNER_MAX
  if (!fits) console.warn('[identity-card] card exceeds the messagebox limit; share it by file instead')
  own = { owner, version, card, fits }
  return own
}

/** Our current card as a file a person can hand over any way they like. */
export async function exportIdentityCard(runtime: WalletRuntime): Promise<string> {
  const card = await ownCard(runtime)
  if (!card || card.card.bapId === null) throw new Error('Publish an identity first.')
  return JSON.stringify(card.card, null, 2)
}

async function sendCard(
  runtime: WalletRuntime,
  to: { identityKey: string; messagebox?: string | null },
  opts: { force: boolean },
): Promise<boolean> {
  const peer = to.identityKey.trim().toLowerCase()
  const pending = inFlight.get(peer)
  if (pending) return pending
  const task = (async () => {
    const card = await ownCard(runtime)
    if (!card) {
      if (opts.force) console.info(`[identity-card] asked by ${peer.slice(0, 12)} but this account presents no identity`)
      return false
    }
    if (!card.fits || !runtimeIsCurrent(runtime)) return false
    const prior = readSent(runtime)[peer]
    if (prior === card.version && !opts.force) return false
    // A withdrawal only matters to someone who saw a card.
    if (card.card.bapId === null && (!prior || prior.startsWith('none:'))) return false
    const sent = await deliverOutbound(envelope(runtime, peer, to.messagebox, identityCardWire(card.card)))
    const kind = card.card.bapId ? 'card' : 'withdrawal'
    if (!deliveryReachedPeer(sent.delivered)) {
      console.warn(`[identity-card] ${kind} to ${peer.slice(0, 12)} not delivered (${sent.delivered})`)
      return false
    }
    recordSent(runtime, peer, card.version)
    console.info(`[identity-card] sent ${kind} to ${peer.slice(0, 12)} via ${sent.delivered}${opts.force ? ' (asked)' : ''}`)
    return true
  })().finally(() => inFlight.delete(peer))
  inFlight.set(peer, task)
  return task
}

function envelope(
  runtime: WalletRuntime,
  peer: string,
  messagebox: string | null | undefined,
  body: string,
): OutboundEnvelope {
  return {
    recipientIdentityKey: peer,
    senderIdentityKey: runtime.instance.identityKey,
    rootKeyHex: runtime.instance.rootKeyHex,
    messagebox: messagebox ?? getFriendByIdentityKey(peer)?.messagebox ?? null,
    peerId: getFriendByIdentityKey(peer)?.id ?? peer,
    body,
  }
}

/** After a delivery reached a contact: send our card if they lack this version. */
export async function shareIdentityCardAfterDelivery(env: OutboundEnvelope): Promise<void> {
  if (isIdentityCardControl(env.body)) return
  const runtime = currentRuntime()
  if (!runtime || !knownPeer(runtime, env.recipientIdentityKey.trim().toLowerCase())) return
  try {
    const sender = PrivateKey.fromHex(env.rootKeyHex.trim()).toPublicKey().toString().toLowerCase()
    if (sender !== runtime.instance.identityKey.toLowerCase()) return
    await sendCard(runtime, { identityKey: env.recipientIdentityKey, messagebox: env.messagebox }, { force: false })
  } catch (err) {
    console.warn('[identity-card] share failed', err instanceof Error ? err.message : String(err))
  }
}

/** Ask a contact for their card; automatic asks run at most once per interval. */
export async function requestIdentityCard(
  friend: Pick<Friend, 'identityKey' | 'messagebox'>,
  opts?: { manual?: boolean },
): Promise<boolean> {
  const runtime = currentRuntime()
  if (!runtime) return false
  const peer = friend.identityKey.trim().toLowerCase()
  const now = Date.now()
  if (!opts?.manual && now - (lastRequested.get(peer) ?? 0) < REQUEST_INTERVAL_MS) return false
  lastRequested.set(peer, now)
  const sent = await deliverOutbound(envelope(runtime, peer, friend.messagebox, IDENTITY_CARD_REQUEST))
  const reached = deliveryReachedPeer(sent.delivered)
  console.info(
    `[identity-card] ${reached ? 'asked' : 'could not ask'} ${peer.slice(0, 12)} for their card via ${sent.delivered}${opts?.manual ? ' (manual)' : ''}`,
  )
  return reached
}

/** A new contact gets our card and is asked for theirs. */
export async function exchangeIdentityCards(friend: Pick<Friend, 'identityKey' | 'messagebox'>): Promise<void> {
  const runtime = currentRuntime()
  if (!runtime) return
  try {
    await sendCard(runtime, friend, { force: false })
    await requestIdentityCard(friend)
  } catch (err) {
    console.warn('[identity-card] exchange failed', err instanceof Error ? err.message : String(err))
  }
}

/** Verify and keep a card someone handed over outside the messagebox. */
export async function importIdentityCard(
  raw: unknown,
  expectedIdentityKey?: string,
): Promise<IdentityCardOutcome> {
  const runtime = currentRuntime()
  if (!runtime) throw new Error('Unlock the wallet to import an identity card.')
  const tracker = await Promise.resolve(runtime.instance.services?.getChainTracker?.()).catch(() => null)
  return rememberIdentityCard(runtime.instance.chain, raw, { tracker, expectedIdentityKey })
}

/**
 * Handle an inbound card or card request from an authenticated sender. Cards
 * from anyone are verified and kept; requests are answered for contacts only.
 */
export async function ingestIdentityCardBody(senderKey: string, inner: string): Promise<void> {
  const runtime = currentRuntime()
  if (!runtime) return
  const peer = senderKey.trim().toLowerCase()
  const friend = knownPeer(runtime, peer)
  if (inner === IDENTITY_CARD_REQUEST) {
    if (!friend) {
      console.info(`[identity-card] request from ${peer.slice(0, 12)} ignored — not a contact`)
      return
    }
    const now = Date.now()
    if (now - (lastAnswered.get(peer) ?? 0) < REQUEST_INTERVAL_MS) return
    lastAnswered.set(peer, now)
    await sendCard(runtime, friend, { force: true }).catch(() => false)
    return
  }
  const raw = identityCardFromWire(inner)
  if (raw === undefined) return
  const started = Date.now()
  const tracker = await Promise.resolve(runtime.instance.services?.getChainTracker?.()).catch(() => null)
  const outcome = await rememberIdentityCard(runtime.instance.chain, raw, { tracker, expectedIdentityKey: peer })
  const ms = Date.now() - started
  if (ms > SLOW_MS) console.info(`[identity-card] verify done ${ms}ms`)
  if (outcome.kind === 'refused') {
    console.warn(`[identity-card] refused card from ${peer.slice(0, 12)}: ${outcome.reason}`)
    return
  }
  console.info(
    outcome.kind === 'presented'
      ? `[identity-card] kept card from ${peer.slice(0, 12)}: ${outcome.identity.bapId}`
      : `[identity-card] kept withdrawal from ${peer.slice(0, 12)}`,
  )
  if (friend) await sendCard(runtime, friend, { force: false }).catch(() => false)
}

export function resetIdentityCardShareForTests(): void {
  own = null
  lastRequested.clear()
  lastAnswered.clear()
  inFlight.clear()
}
