import type { ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { reloadIdentityCardsFromStorage } from './identityCard'
import {
  parseProfileCertificate,
  verifyIdentityProfile,
  type IdentityProfileRecord,
} from './identityProfile'
import {
  identityProfileRecord,
  rememberIdentityProfile,
  storedIdentityProfiles,
} from './identityProfiles'
import {
  issuerIdentityPackage,
  rememberConfirmedIssuerIdentityPackage,
  rememberIssuerIdentityPackage,
  storedIssuerIdentities,
} from './issuerIdentities'
import { parseIssuerIdentityPackage, type IssuerIdentityPackage } from './issuerIdentity'
import { normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'
import { onVaultLinkMessage, sendOverVaultLink, vaultLinkOpen } from './vaultLink'
import { getActiveWallet } from './session'
import type { Chain } from './vault'

export type DevicePeerProfileEntry = {
  identityKey: string
  record: IdentityProfileRecord
  name: string
  description: string
  issuedAt: string
}

export type DevicePeerCardLink = {
  key?: string
  bapId?: string
  issuedAt: string
  receivedAt: number
}

export type DevicePeerOwnPresentation = {
  owner: string
  selected?: string
  presented?: string
  presentedAt?: string
  unsigned?: boolean
  published?: Record<string, string>
}

export type DevicePeerIdentitiesBundle = {
  v: 1
  chain: Chain
  identityKey: string
  exportedAt: number
  profiles: DevicePeerProfileEntry[]
  bapPackages: IssuerIdentityPackage[]
  cards?: Record<string, DevicePeerCardLink>
  ownPresentation?: DevicePeerOwnPresentation
}

export type IdentityBundleMergeResult = {
  profilesAdded: number
  bapPackagesAdded: number
  cardsAdded: number
}

const MAX_LAN_BUNDLE_BYTES = 1_200_000
const MAX_LINK_BUNDLE_BYTES = 180_000
const REQUEST_COOLDOWN_MS = 15_000
export const VAULT_IDENTITIES_BOX = 'vault-identities'
const OWN_BOX_STALE_MS = 7 * 24 * 60 * 60 * 1000
const lastVaultBoxHash = new Map<string, string>()

type VaultLinkIdentityRequest = {
  type: 'identity-sync-request'
  chain: Chain
  requestId: string
  identityKeys?: string[]
  bapIds?: string[]
}

type VaultLinkIdentityResponse = {
  type: 'identity-sync-response'
  chain: Chain
  requestId: string
  bundle: DevicePeerIdentitiesBundle
}

function readOwnPresentation(
  chain: Chain,
  accountIndex: number,
  identityKey: string,
): DevicePeerOwnPresentation | undefined {
  const trimmed = identityKey.trim()
  const lower = trimmed.toLowerCase()
  const keys = [
    `${storageRegistry.publicIdentities.key}:wallet:${chain}:${accountIndex}:${trimmed}`,
    `${storageRegistry.publicIdentities.key}:wallet:${chain}:${accountIndex}:${lower}`,
  ]
  for (const key of keys) {
    const raw = durableGetItem(key)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const owner = normalizeIssuerIdentityKey(parsed.owner) ?? lower
      const selected = normalizeIssuerIdentityKey(parsed.selected) ?? undefined
      const presented = normalizeIssuerIdentityKey(parsed.presented) ?? undefined
      const presentedAt = typeof parsed.presentedAt === 'string' ? parsed.presentedAt : undefined
      const unsigned = parsed.unsigned === true ? true : undefined
      const published: Record<string, string> = {}
      if (Array.isArray(parsed.identities)) {
        for (const item of parsed.identities as Array<Record<string, unknown>>) {
          const ik = normalizeIssuerIdentityKey(item?.identityKey)
          const bap = normalizeBapId(item?.published)
          if (ik && bap) published[ik] = bap
        }
      }
      return {
        owner,
        ...(selected ? { selected } : {}),
        ...(presented ? { presented } : {}),
        ...(presentedAt ? { presentedAt } : {}),
        ...(unsigned ? { unsigned } : {}),
        ...(Object.keys(published).length ? { published } : {}),
      }
    } catch {
      /* ignore corrupt store */
    }
  }
  return undefined
}

function readIdentityCardLinks(chain: Chain): Record<string, DevicePeerCardLink> {
  const raw = durableGetItem(`${storageRegistry.identityCards.key}:${chain}`)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; links?: Record<string, unknown> }
    if (parsed?.version !== 1 || !parsed.links || typeof parsed.links !== 'object') return {}
    const out: Record<string, DevicePeerCardLink> = {}
    for (const [walletKey, value] of Object.entries(parsed.links)) {
      const owner = normalizeIssuerIdentityKey(walletKey)
      if (!owner || !value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      if (typeof row.issuedAt !== 'string' || typeof row.receivedAt !== 'number') continue
      const key = normalizeIssuerIdentityKey(row.key) ?? undefined
      const bapId = normalizeBapId(row.bapId) ?? undefined
      if (key || bapId) {
        out[owner] = { ...(key ? { key } : {}), ...(bapId ? { bapId } : {}), issuedAt: row.issuedAt, receivedAt: row.receivedAt }
      }
    }
    return out
  } catch {
    return {}
  }
}

function mergeIdentityCardLinks(chain: Chain, incoming: Record<string, DevicePeerCardLink> | undefined): number {
  if (!incoming || typeof incoming !== 'object') return 0
  const key = `${storageRegistry.identityCards.key}:${chain}`
  const existing = readIdentityCardLinks(chain)
  let added = 0
  for (const [walletKey, row] of Object.entries(incoming)) {
    const owner = normalizeIssuerIdentityKey(walletKey)
    if (!owner || !row || typeof row !== 'object') continue
    if (typeof row.issuedAt !== 'string' || typeof row.receivedAt !== 'number') continue
    const presentedKey = normalizeIssuerIdentityKey(row.key) ?? undefined
    const presentedBap = normalizeBapId(row.bapId) ?? undefined
    if (!presentedKey && !presentedBap) continue
    const prior = existing[owner]
    if (prior && prior.issuedAt >= row.issuedAt) continue
    existing[owner] = {
      ...(presentedKey ? { key: presentedKey } : {}),
      ...(presentedBap ? { bapId: presentedBap } : {}),
      issuedAt: row.issuedAt,
      receivedAt: row.receivedAt,
    }
    added++
  }
  if (added > 0) {
    const entries = Object.entries(existing)
      .sort((a, b) => b[1].receivedAt - a[1].receivedAt)
      .slice(0, 256)
    durableSetItem(key, JSON.stringify({ version: 1, links: Object.fromEntries(entries) }))
    reloadIdentityCardsFromStorage(chain)
  }
  return added
}

/**
 * Export verified local identity profiles, BAP issuer packages, and non-secret
 * presentation metadata so a connected same-vault device can fill missing data.
 */
export function exportLocalIdentityBundle(args: {
  chain: Chain
  accountIndex: number
  identityKey: string
  filterKeys?: Iterable<string>
  filterBapIds?: Iterable<string>
  maxBytes?: number
}): DevicePeerIdentitiesBundle {
  const { chain, accountIndex, identityKey } = args
  const maxBytes = args.maxBytes ?? MAX_LAN_BUNDLE_BYTES
  const wantKeys = args.filterKeys
    ? new Set(Array.from(args.filterKeys, (k) => normalizeIssuerIdentityKey(k)).filter(Boolean) as string[])
    : null
  const wantBaps = args.filterBapIds
    ? new Set(Array.from(args.filterBapIds, (b) => normalizeBapId(b)).filter(Boolean) as string[])
    : null

  const profiles: DevicePeerProfileEntry[] = []
  const bapPackages: IssuerIdentityPackage[] = []
  const ownPresentation = readOwnPresentation(chain, accountIndex, identityKey)
  const cards = wantKeys || wantBaps ? undefined : readIdentityCardLinks(chain)

  let usedBytes = JSON.stringify({
    v: 1,
    chain,
    identityKey,
    exportedAt: 0,
    profiles: [],
    bapPackages: [],
    ...(cards && Object.keys(cards).length ? { cards } : {}),
    ...(ownPresentation ? { ownPresentation } : {}),
  }).length

  for (const prof of storedIdentityProfiles(chain)) {
    if (wantKeys && wantKeys.size > 0 && !wantKeys.has(prof.identityKey)) continue
    const record = identityProfileRecord(chain, prof.identityKey)
    if (!record) continue
    const entry: DevicePeerProfileEntry = {
      identityKey: prof.identityKey,
      record,
      name: prof.name,
      description: prof.description,
      issuedAt: prof.issuedAt,
    }
    const size = JSON.stringify(entry).length + 2
    if (usedBytes + size > maxBytes) continue
    profiles.push(entry)
    usedBytes += size
  }

  for (const identity of storedIssuerIdentities(chain)) {
    const matchesKey = wantKeys && wantKeys.size > 0 && identity.links.some((l) => wantKeys.has(l.identityKey))
    const matchesBap = wantBaps && wantBaps.size > 0 && wantBaps.has(identity.bapId)
    if ((wantKeys && wantKeys.size > 0) || (wantBaps && wantBaps.size > 0)) {
      if (!matchesKey && !matchesBap) continue
    }
    const pkg = issuerIdentityPackage(chain, identity.bapId)
    if (!pkg) continue
    const size = JSON.stringify(pkg).length + 2
    if (usedBytes + size > maxBytes) continue
    bapPackages.push(pkg)
    usedBytes += size
  }

  return {
    v: 1,
    chain,
    identityKey,
    exportedAt: Date.now(),
    profiles,
    bapPackages,
    ...(cards && Object.keys(cards).length ? { cards } : {}),
    ...(ownPresentation ? { ownPresentation } : {}),
  }
}

/**
 * Cryptographically verify and merge an identity bundle received from a
 * connected peer device. Invalid or older entries are ignored.
 */
export async function mergeRemoteIdentityBundle(
  chain: Chain,
  raw: unknown,
  opts?: { tracker?: ChainTracker | null; allowUncheckedBapHeaders?: boolean },
): Promise<IdentityBundleMergeResult> {
  const result: IdentityBundleMergeResult = { profilesAdded: 0, bapPackagesAdded: 0, cardsAdded: 0 }
  if (!raw || typeof raw !== 'object') return result
  const bundle = raw as Partial<DevicePeerIdentitiesBundle>
  if (bundle.v !== 1 || bundle.chain !== chain) return result

  if (Array.isArray(bundle.profiles)) {
    for (const entry of bundle.profiles) {
      const ik = normalizeIssuerIdentityKey(entry?.identityKey)
      const cert = parseProfileCertificate(entry?.record?.certificate)
      if (!ik || !cert) continue
      const images = entry?.record?.image ? [entry.record.image] : []
      const verified = await verifyIdentityProfile(ik, cert, images)
      if (!verified) continue
      if (rememberIdentityProfile(chain, verified)) {
        result.profilesAdded++
      }
    }
  }

  if (Array.isArray(bundle.bapPackages)) {
    for (const rawPkg of bundle.bapPackages) {
      const pkg = parseIssuerIdentityPackage(rawPkg)
      if (!pkg) continue
      const kept = opts?.tracker
        ? await rememberConfirmedIssuerIdentityPackage(chain, pkg, opts.tracker)
        : opts?.allowUncheckedBapHeaders !== false
          ? rememberIssuerIdentityPackage(chain, pkg)
          : null
      if (kept) result.bapPackagesAdded++
    }
  }

  if (bundle.cards && typeof bundle.cards === 'object') {
    result.cardsAdded = mergeIdentityCardLinks(chain, bundle.cards)
  }

  return result
}

let vaultLinkUnsub: (() => void) | null = null
const lastRequestedAt = new Map<string, number>()

/**
 * Subscribe to `vaultLink` so same-vault installs automatically exchange
 * missing identity profiles and BAP packages over direct WebRTC links.
 */
export function startVaultLinkIdentitySync(): () => void {
  if (vaultLinkUnsub) return vaultLinkUnsub
  vaultLinkUnsub = onVaultLinkMessage((body, device) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const msg = parsed as Record<string, unknown>
    if (msg.type === 'identity-sync-request' && typeof msg.requestId === 'string') {
      const active = getActiveWallet()
      if (!active || (typeof msg.chain === 'string' && msg.chain !== active.chain)) return
      const bundle = exportLocalIdentityBundle({
        chain: active.chain,
        accountIndex: active.accountIndex,
        identityKey: active.identityKey,
        filterKeys: Array.isArray(msg.identityKeys) ? (msg.identityKeys as string[]) : undefined,
        filterBapIds: Array.isArray(msg.bapIds) ? (msg.bapIds as string[]) : undefined,
        maxBytes: MAX_LINK_BUNDLE_BYTES,
      })
      if (bundle.profiles.length === 0 && bundle.bapPackages.length === 0 && !bundle.cards) return
      const reply: VaultLinkIdentityResponse = {
        type: 'identity-sync-response',
        chain: active.chain,
        requestId: msg.requestId,
        bundle,
      }
      void sendOverVaultLink(device, JSON.stringify(reply)).catch(() => {})
      return
    }
    if (msg.type === 'identity-sync-response' && msg.bundle) {
      const active = getActiveWallet()
      if (!active || msg.chain !== active.chain) return
      void mergeRemoteIdentityBundle(active.chain, msg.bundle, {
        allowUncheckedBapHeaders: true,
      }).catch(() => {})
    }
  })
  return () => {
    vaultLinkUnsub?.()
    vaultLinkUnsub = null
  }
}

/**
 * Ask connected `vaultLink` devices for missing identity profiles / BAP packages.
 */
export async function requestIdentitiesOverVaultLink(args: {
  chain: Chain
  devices: Iterable<string>
  identityKeys?: string[]
  bapIds?: string[]
  now?: number
}): Promise<number> {
  const now = args.now ?? Date.now()
  const keys = (args.identityKeys ?? []).map((k) => normalizeIssuerIdentityKey(k)).filter(Boolean) as string[]
  const bapIds = (args.bapIds ?? []).map((b) => normalizeBapId(b)).filter(Boolean) as string[]
  let sent = 0
  for (const device of new Set(args.devices)) {
    if (!device || !vaultLinkOpen(device)) continue
    const dedupe = `${device}:${args.chain}:${keys.join(',')}:${bapIds.join(',')}`
    const prev = lastRequestedAt.get(dedupe) ?? 0
    if (now - prev < REQUEST_COOLDOWN_MS) continue
    lastRequestedAt.set(dedupe, now)
    const req: VaultLinkIdentityRequest = {
      type: 'identity-sync-request',
      chain: args.chain,
      requestId: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      ...(keys.length ? { identityKeys: keys } : {}),
      ...(bapIds.length ? { bapIds } : {}),
    }
    const delivery = await sendOverVaultLink(device, JSON.stringify(req))
    if (delivery === 'direct') sent++
  }
  return sent
}

export function resetIdentityPeerSyncForTests(): void {
  vaultLinkUnsub?.()
  vaultLinkUnsub = null
  lastRequestedAt.clear()
  lastVaultBoxHash.clear()
}

/**
 * Pull remote vault identity snapshots and publish this device's latest
 * verified profiles/BAP packages/cards into the vault's BRC-78-sealed
 * `vault-identities` own-box so connected devices sync even without LAN/WebRTC.
 */
export async function syncVaultIdentitiesBox(): Promise<IdentityBundleMergeResult> {
  const totals: IdentityBundleMergeResult = { profilesAdded: 0, bapPackagesAdded: 0, cardsAdded: 0 }
  const active = getActiveWallet()
  if (!active?.vaultMaster) return totals
  try {
    const [
      { acknowledgeOwnBox, listOwnBox, openFromSelf, sealToSelf, sendToOwnBox },
      { rootKeyHexForAccount },
      { getOrCreateDeviceId },
      { Hash, Utils },
    ] = await Promise.all([
      import('./messageTransport'),
      import('./vaultAccounts'),
      import('./deviceWallets'),
      import('@bsv/sdk'),
    ])
    const vaultRootHex = rootKeyHexForAccount(active.vaultMaster, 0)
    const deviceId = getOrCreateDeviceId()
    const now = Date.now()
    const listed = await listOwnBox(vaultRootHex, VAULT_IDENTITIES_BOX)
    const ownIds: Array<{ createdAt: number; id: string }> = []
    const staleIds: string[] = []
    let latestOwnHash: string | null = null
    if (Array.isArray(listed)) {
      for (const m of listed) {
        const inner = openFromSelf(vaultRootHex, m.body)
        if (!inner) continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(inner) as Record<string, unknown>
        } catch {
          continue
        }
        if (frame.type !== 'vault-identity-snapshot') continue
        const frameChain = typeof frame.chain === 'string' ? frame.chain : ''
        const frameDev = typeof frame.deviceId === 'string' ? frame.deviceId : ''
        const createdAt = Number(m.createdAt) || 0
        if (frameChain === active.chain && frame.bundle) {
          const res = await mergeRemoteIdentityBundle(active.chain, frame.bundle, {
            allowUncheckedBapHeaders: true,
          })
          totals.profilesAdded += res.profilesAdded
          totals.bapPackagesAdded += res.bapPackagesAdded
          totals.cardsAdded += res.cardsAdded
        }
        if (m.messageId) {
          const id = String(m.messageId)
          if (frameDev === deviceId && frameChain === active.chain) {
            ownIds.push({ createdAt, id })
            if (typeof frame.bundleHash === 'string') latestOwnHash = frame.bundleHash
          } else if (createdAt > 0 && now - createdAt > OWN_BOX_STALE_MS) {
            staleIds.push(id)
          }
        }
      }
    }
    const bundle = exportLocalIdentityBundle({
      chain: active.chain,
      accountIndex: active.accountIndex,
      identityKey: active.identityKey,
      maxBytes: MAX_LINK_BUNDLE_BYTES,
    })
    const hasData =
      bundle.profiles.length > 0 ||
      bundle.bapPackages.length > 0 ||
      (bundle.cards != null && Object.keys(bundle.cards).length > 0)
    if (hasData) {
      const { exportedAt: _omit, ...stable } = bundle
      const bundleHash = Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(stable), 'utf8')))
      const cacheKey = `${active.chain}:${deviceId}`
      const already = lastVaultBoxHash.get(cacheKey) === bundleHash || latestOwnHash === bundleHash
      if (!already) {
        const frame = {
          type: 'vault-identity-snapshot',
          v: 1,
          deviceId,
          chain: active.chain,
          bundleHash,
          bundle,
        }
        await sendToOwnBox(vaultRootHex, VAULT_IDENTITIES_BOX, sealToSelf(vaultRootHex, JSON.stringify(frame)))
        lastVaultBoxHash.set(cacheKey, bundleHash)
        for (const old of ownIds) staleIds.push(old.id)
      } else if (ownIds.length > 1) {
        ownIds.sort((a, b) => b.createdAt - a.createdAt)
        for (const old of ownIds.slice(1)) staleIds.push(old.id)
      }
    }
    if (staleIds.length > 0) {
      await acknowledgeOwnBox(vaultRootHex, VAULT_IDENTITIES_BOX, staleIds).catch(() => {})
    }
  } catch {
    /* best-effort background sync */
  }
  return totals
}
