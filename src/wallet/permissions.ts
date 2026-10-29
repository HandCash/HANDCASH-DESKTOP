import type { EcpmAuthorizationRequest } from '@bsv/ecpm-permission-module'
import { clearEcpmPermissions } from './ecpm'
import {
  appDisplayName,
  normalizeAppHost,
} from './appIdentity'
import type { BridgeChannel } from './bridgeOrigin'
import { brc100Contract } from '../contracts/brc100'
import { storageRegistry } from '../storage/registry'
import { canAutoProcessPayment, clearAutoPaySettings, reserveAutoPayPayment, type AutoPayReservation } from './autoPay'
import {
  grantableCollectionIdsFromOutputs,
  grantableCollectionsFromOutputs,
  grantableTokensFromOutputs,
  isTokenReceiveArgs,
  isTokenSpendArgs,
  isItemBasket,
  isItemIssuanceArgs,
  isItemReceiveArgs,
  isItemSpendArgs,
  isThirdPartyOriginator,
  isTokenViewBasket,
  itemViewGranted,
  mergeItemViewGrant,
  mergeTokenViewGrant,
  normalizeItemAccess,
  normalizeTokenAccess,
  isLeftoverThirdPartyItem,
  isRetiredFungibleRow,
  outputMatchesItemAccess,
  outputMatchesTokenAccess,
  parseItemViewRequest,
  parseTokenViewRequest,
  tokenViewGranted,
  isHandCashCatalogOrigin,
  viewGrantOriginAliases,
  type CountersignedScheme,
  type CountersignedViewRequest,
  type ItemAccess,
  type ItemViewRequest,
  type TokenAccess,
  type TokenViewRequest,
} from './itemAccess'
import { formatBsvSignificant} from './session'
import { HOME_HANDLE_DOMAIN } from './handleDomain'
import { accountLocalKey, peekAccountLocalKeyScope } from './accountLocalKeys.js'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { walletIdentityProofPurpose } from './walletIdentityProof'
import { marketListingPreviewFromArgs } from './marketListing'
import type { IssuanceAttestation } from './identityIssuance'
import { formatUsd } from './fx'
import { coinBudgetSats, coinUsdValue } from './coins/budget'
import { coinApprovalTitle, COIN_INFO, formatCoin, isCoinChain } from './coins/coinChains'
import { bntAmountLabel } from './bnt/assetLabel'

const STORAGE_KEY_BASE = storageRegistry.connectedApps.key

function connectedAppsStorageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

export type PermissionDecision = 'allow' | 'deny'
export type PermissionLifetime = 'once' | 'session' | 'remember'

export type ConnectedApp = {
  origin: string
  name: string
  connectedAt: number
  /** Collectable / NFT capabilities — never implied by Pay. */
  itemAccess?: ItemAccess
  /** Token view — never implied by item view. */
  tokenAccess?: TokenAccess
  /** Issuer-accepted views granted, per profile (`iptft`, `iptnft`) — never implied by item or token view. */
  countersignedViews?: CountersignedScheme[]
  /** Granted with Connect Authorize — automatic plain-BSV internalizeAction. */
  acceptIncomingFunds?: boolean
  /** `in-app`: connected in a Mobile app tab, so the loopback socket may not use it. */
  connectedVia?: 'in-app'
}

export type PendingPermission = {
  id: number
  kind: 'connect'
  origin: string
  method: string
  createdAt: number
  /** BRC spendingAuthorization from the app's manifest.json (if any). */
  spendingAuthorization?: {
    amountSats: number
    description: string
  }
}

export type PendingAction = {
  permissionLifetime?: PermissionLifetime
  featureAccess?: { capabilities: string[]; grouped?: boolean; singleRequest?: boolean }
  id: number
  kind: 'action'
  bridgeRequestId?: number
  origin: string
  method: string
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
  /** Second amount line for a payment not in BSV (its USD value); `amountSats` always renders as BSV. */
  amountNote?: string
  /**
   * Held tip this action would sell. The prompt resolves the picture and name
   * from the wallet's own basket — an app may name an outpoint, it never gets
   * to describe what the user is about to approve.
   */
  itemOutpoint?: string
  /** Token id when this action issues, mints or sends a token. */
  tokenId?: string
  /** Market listing display when the buyer does not yet hold the item. */
  itemName?: string
  itemImageUrl?: string
  previewKind?: 'token' | 'collectable'
  /** Whether this mint carries a BRC-247 issuer stamp; the prompt always says which. */
  issuance?:
    | {
        kind: 'signed'
        identityKey: string
        displayName?: string
        /** The wallet funds and sends a 2-sat Sigma anchor transaction with the mint. */
        anchor: boolean
      }
    | { kind: 'unsigned' }
  createdAt: number
}

export type PendingPrompt = PendingPermission | PendingAction

type PromptListener = (pending: PendingPrompt | null) => void
type ConnectedListener = (apps: ConnectedApp[]) => void

let idCounter = 1
/** Multiple UI surfaces (Dashboard column + locked modals + mobile nav) may listen. */
const promptListeners = new Set<PromptListener>()
const connectedListeners = new Set<ConnectedListener>()
let current: {
  request: PendingPrompt
  resolve: (decision: PermissionDecision) => void
} | null = null
const queue: Array<{
  request: PendingPrompt
  resolve: (decision: PermissionDecision) => void
}> = []

function migrateRaw(raw: string | null): ConnectedApp[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      if (parsed.every((v) => typeof v === 'string')) {
        return (parsed as string[]).map((origin) => ({
          origin: normalizeAppHost(origin),
          name: appDisplayName(origin),
          connectedAt: Date.now(),
        }))
      }
      return (parsed as ConnectedApp[])
        .filter((a) => a && typeof a.origin === 'string')
        .map((a) => ({
          origin: normalizeAppHost(a.origin),
          name: appDisplayName(a.origin),
          connectedAt: typeof a.connectedAt === 'number' ? a.connectedAt : Date.now(),
          itemAccess: a.itemAccess ? normalizeItemAccess(a.itemAccess) : undefined,
          tokenAccess: a.tokenAccess ? normalizeTokenAccess(a.tokenAccess) : undefined,
          ...(Array.isArray(a.countersignedViews) && a.countersignedViews.length
            ? { countersignedViews: a.countersignedViews.filter((v) => v === 'iptft' || v === 'iptnft') }
            : {}),
          acceptIncomingFunds:
            a.acceptIncomingFunds === true
              ? true
              : a.acceptIncomingFunds === false
                ? false
                : undefined,
          ...(a.connectedVia === 'in-app' ? { connectedVia: 'in-app' as const } : {}),
        }))
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { apps?: unknown }).apps)) {
      return migrateRaw(JSON.stringify((parsed as { apps: unknown[] }).apps))
    }
  } catch {
    // ignore
  }
  return []
}

function readConnected(): ConnectedApp[] {
  // Prefer durable / new key; fall back to legacy allowlist key (primary only).
  const next = durableGetItem(connectedAppsStorageKey())
  if (next) return migrateRaw(next)
  if (peekAccountLocalKeyScope().accountIndex === 0) {
    const legacy = durableGetItem(storageRegistry.legacyAllowedOrigins.key)
    if (legacy) {
      const apps = migrateRaw(legacy)
      writeConnected(apps)
      return apps
    }
  }
  return []
}

function emitConnected(): void {
  const apps = listConnectedApps()
  for (const cb of connectedListeners) cb(apps)
}

function writeConnected(apps: ConnectedApp[]): void {
  const dedup = new Map<string, ConnectedApp>()
  for (const app of apps) {
    dedup.set(app.origin, app)
  }
  durableSetItem(
    connectedAppsStorageKey(),
    JSON.stringify([...dedup.values()]),
  )
  emitConnected()
}

function dispatchWalletUiEvent(
  type: 'handcash:permission-request' | 'handcash:wallet-connected' | 'handcash:permission-dismissed',
  detail: Record<string, unknown>,
): void {
  try {
    document.dispatchEvent(new CustomEvent(type, { detail }))
  } catch {
    // Non-DOM environments (tests) — ignore.
  }
}

function notify(): void {
  const pending = current?.request ?? null
  for (const cb of promptListeners) cb(pending)
}

function pumpQueue(): void {
  if (current || queue.length === 0) {
    notify()
    syncPermissionSpendPriority()
    return
  }
  current = queue.shift() ?? null
  notify()
  syncPermissionSpendPriority()
  const raisedFor = current?.request.id
  // A retry after the prompt is answered would pull the wallet back over the
  // app that `releasePromptFocus` just returned to.
  const focus = () => {
    if (typeof window !== 'undefined' && current?.request.id === raisedFor) {
      void window.handcash?.focusWindow?.()
    }
  }
  focus()
  // Mobile OEMs often ignore the first background startActivity; retry briefly.
  try {
    window.setTimeout(focus, 280)
    window.setTimeout(focus, 900)
  } catch {
    // Non-DOM environments (tests) — ignore.
  }
  // Mobile shell listens to bring the app forward + show a heads-up if needed.
  const prompt = current?.request
  if (prompt) {
    const appName = appDisplayName(prompt.origin)
    dispatchWalletUiEvent('handcash:permission-request', {
      kind: prompt.kind,
      origin: prompt.origin,
      appName,
      title:
        prompt.kind === 'action' ? prompt.title : `Connect to ${appName}`,
    })
  }
}

/**
 * While a connect/pay prompt is open, yield the wallet FIFO the same way a
 * queued spend does — so BRC-39 encrypt/upload cannot sit ahead of Approve.
 */
let releasePermissionSpendPriority: (() => void) | null = null
let inboundWalletRequests = 0
function syncPermissionSpendPriority(): void {
  void import('./walletCoordinator')
    .then(async ({ requestSpendPriority }) => {
      // Re-read intent inside the callback: the prompt may have resolved while
      // the dynamic import was in flight.
      // Inbound BRC-100 reads must not masquerade as a permission prompt — a
      // wedged listOutputs held spend priority for 90s+ with no UI to dismiss.
      const want = current != null || queue.length > 0
      if (want && !releasePermissionSpendPriority) {
        releasePermissionSpendPriority = requestSpendPriority('permission-prompt')
        // Let unlock recompose / chain ingest observe the hold and yield a paint
        // turn before Argon2 or IDB work continues.
        try {
          const { yieldToUi } = await import('./yieldToUi')
          await yieldToUi()
        } catch {
          /* ignore */
        }
      } else if (!want && releasePermissionSpendPriority) {
        releasePermissionSpendPriority()
        releasePermissionSpendPriority = null
      }
    })
    .catch(() => {
      /* coordinator optional in tests */
    })
}

function enqueuePrompt(request: PendingPrompt): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    queue.push({ request, resolve })
    pumpQueue()
  })
}

export function isPublicMethod(method: string): boolean {
  return brc100Contract.isPublicMethod(method)
}

export function isSilentAuthMethod(method: string): boolean {
  return brc100Contract.isSilentAuthMethod(method)
}

export function isConnectMethod(method: string): boolean {
  return brc100Contract.isConnectMethod(method)
}

export function isActionMethod(method: string): boolean {
  return brc100Contract.isActionMethod(method)
}

/** Identity / ownership proofs that often follow a Connect authorize. */
export function isIdentityProofMethod(method: string): boolean {
  // Generic signatures are not automatically identity proofs and must never
  // inherit a method-wide grant. The advertised identity recipe gets an
  // explicit, purpose-bearing approval for every challenge.
  return method === 'proveCertificate'
}

const FRESH_CONNECT_MS = 20_000
const recentlyConnectedAt = new Map<string, number>()
const sessionApprovedProofs = new Set<string>()

function proofGrantKey(origin: string, method: string): string {
  return `${origin}::${method}`
}

function wasRecentlyConnected(origin: string): boolean {
  const at = recentlyConnectedAt.get(origin)
  if (at == null) return false
  if (Date.now() - at >= FRESH_CONNECT_MS) {
    recentlyConnectedAt.delete(origin)
    return false
  }
  return true
}

function markRecentlyConnected(origin: string): void {
  const now = Date.now()
  recentlyConnectedAt.set(origin, now)
  // Drop expired entries so a chatty origin list cannot grow forever.
  for (const [key, at] of recentlyConnectedAt) {
    if (now - at >= FRESH_CONNECT_MS) recentlyConnectedAt.delete(key)
  }
}

export function clearPermissionSession(origin?: string): void {
  clearEcpmPermissions()
  if (!origin) {
    recentlyConnectedAt.clear()
    sessionApprovedProofs.clear()
    return
  }
  const key = normalizeOrigin(origin)
  recentlyConnectedAt.delete(key)
  for (const grant of [...sessionApprovedProofs]) {
    if (grant.startsWith(`${key}::`)) sessionApprovedProofs.delete(grant)
  }
}

/**
 * The host every grant, prompt and activity row is keyed and shown by. It is
 * the caller's own host, never an alias: renaming one host to another would
 * show the user a site they are not on and hand it that site's grants.
 */
export function normalizeOrigin(origin: string | undefined): string {
  return normalizeAppHost(origin)
}

export function isOriginAllowed(origin: string | undefined): boolean {
  const aliases = new Set(viewGrantOriginAliases(origin))
  aliases.add(normalizeOrigin(origin))
  return readConnected().some(
    (a) => aliases.has(a.origin) || aliases.has(normalizeAppHost(a.origin)),
  )
}


/** Reload Connected apps for the active vault account. */
export function rebindConnectedAppsForAccount(): void {
  cancelPendingPermissions('account-changed')
  clearPermissionSession()
  emitConnected()
}

export function listConnectedApps(): ConnectedApp[] {
  return readConnected()
}

/** @deprecated prefer listConnectedApps */
export function listAllowedOrigins(): string[] {
  return readConnected().map((a) => a.origin)
}

function findConnectedApp(origin: string | undefined): {
  idx: number
  apps: ConnectedApp[]
  key: string
} {
  const key = normalizeOrigin(origin)
  const apps = readConnected()
  const aliases = new Set(viewGrantOriginAliases(origin))
  aliases.add(key)
  const idx = apps.findIndex(
    (a) => aliases.has(a.origin) || aliases.has(normalizeAppHost(a.origin)),
  )
  return { idx, apps, key }
}

function ensureConnectedApp(origin: string | undefined): {
  idx: number
  apps: ConnectedApp[]
  key: string
} {
  const found = findConnectedApp(origin)
  if (found.idx >= 0) return found
  const row: ConnectedApp = {
    origin: found.key,
    name: appDisplayName(found.key),
    connectedAt: Date.now(),
  }
  return { idx: 0, apps: [row, ...found.apps], key: found.key }
}

/** The channel a connected app's grants are bound to; null when not connected. */
export function connectedAppChannel(origin: string | undefined): BridgeChannel | null {
  const { idx, apps } = findConnectedApp(origin)
  if (idx < 0) return null
  return apps[idx]!.connectedVia === 'in-app' ? 'in-app' : 'socket'
}

export function allowOrigin(origin: string | undefined, channel: BridgeChannel = 'socket'): void {
  const { idx, apps, key } = findConnectedApp(origin)
  const prior = idx >= 0 ? apps[idx] : undefined
  const existing = idx >= 0 ? apps.filter((_, i) => i !== idx) : apps
  const connectedVia = prior ? prior.connectedVia : channel === 'in-app' ? 'in-app' : undefined
  writeConnected([
    {
      ...(connectedVia ? { connectedVia } : {}),
      origin: prior?.origin ?? key,
      name: prior?.name ?? appDisplayName(key),
      connectedAt: prior?.connectedAt ?? Date.now(),
      // Connect does not by itself grant item/token view. Reconnect must reuse
      // a prior View items / View tokens Allow so catalog reloads do not re-prompt.
      itemAccess: prior?.itemAccess,
      tokenAccess: prior?.tokenAccess,
      ...(prior?.countersignedViews?.length ? { countersignedViews: prior.countersignedViews } : {}),
      // Plain BSV receive is part of Connect. Preserve an explicit user opt-out
      // ("Require receive approval"); otherwise grant / restore the default.
      acceptIncomingFunds: prior?.acceptIncomingFunds === false ? false : true,
    },
    ...existing,
  ])
  markRecentlyConnected(key)
}

export function getItemAccess(origin: string | undefined): ItemAccess {
  const { idx, apps } = findConnectedApp(origin)
  return normalizeItemAccess(idx >= 0 ? apps[idx]?.itemAccess : undefined)
}

export function getTokenAccess(origin: string | undefined): TokenAccess {
  const { idx, apps } = findConnectedApp(origin)
  return normalizeTokenAccess(idx >= 0 ? apps[idx]?.tokenAccess : undefined)
}

export function acceptsIncomingFunds(origin: string | undefined): boolean {
  const { idx, apps } = findConnectedApp(origin)
  if (idx < 0) return false
  // Connected apps default to auto-accept (including legacy rows with no flag).
  // Explicit false = user chose "Require receive approval".
  return apps[idx]?.acceptIncomingFunds !== false
}

export function setAcceptIncomingFunds(
  origin: string | undefined,
  enabled: boolean,
): void {
  const { idx, apps } = ensureConnectedApp(origin)
  const copy = [...apps]
  // Persist explicit false so legacy undefined (default on) stays distinct from opt-out.
  copy[idx] = { ...copy[idx]!, acceptIncomingFunds: enabled }
  writeConnected(copy)
}

function patchItemAccess(
  origin: string | undefined,
  patch: (current: ItemAccess) => ItemAccess,
): ItemAccess {
  const { idx, apps } = ensureConnectedApp(origin)
  const next = patch(normalizeItemAccess(apps[idx]!.itemAccess))
  const copy = [...apps]
  copy[idx] = { ...copy[idx]!, itemAccess: next }
  writeConnected(copy)
  return next
}

function patchTokenAccess(
  origin: string | undefined,
  patch: (current: TokenAccess) => TokenAccess,
): TokenAccess {
  const { idx, apps } = ensureConnectedApp(origin)
  const next = patch(normalizeTokenAccess(apps[idx]!.tokenAccess))
  const copy = [...apps]
  copy[idx] = { ...copy[idx]!, tokenAccess: next }
  writeConnected(copy)
  return next
}

export function revokeOrigin(origin: string): void {
  const key = normalizeOrigin(origin)
  const name = appDisplayName(key)
  writeConnected(readConnected().filter((a) => a.origin !== key))
  clearAutoPaySettings(key)
  void import('./spendingAuthorization').then(({ clearSpendingAuthorization }) => {
    clearSpendingAuthorization(key)
  })
  clearPermissionSession(key)
  // Keep history — only drop the live connection. Activity still shows the unlink.
  void import('./appActivity').then(({ recordWalletEvent }) => {
    recordWalletEvent({
      origin: key,
      method: 'disconnect',
      note: `Disconnected ${name}`,
    })
  })
}

export function revokeAllOrigins(): void {
  writeConnected([])
  clearAutoPaySettings()
  void import('./spendingAuthorization').then(({ clearSpendingAuthorization }) => {
    clearSpendingAuthorization()
  })
  clearPermissionSession()
}

/** True when a connect/pay/sign prompt is showing or queued — heavy sync must yield. */
export function hasPendingPermissionPrompt(): boolean {
  return current != null || queue.length > 0
}

/**
 * Inbound :3321 wallet requests that have been accepted but not finished.
 * Set as soon as the HTTP event arrives — not after JS is free of Argon2 —
 * so backup/chain-ingest yield before getVersion/isAuthenticated/waitForAuthentication.
 */
export function hasInboundWalletRequest(): boolean {
  return inboundWalletRequests > 0
}

/** Mark a live BRC-100 HTTP request. Caller must invoke the returned release. */
export function noteInboundWalletRequest(): () => void {
  inboundWalletRequests += 1
  syncPermissionSpendPriority()
  void import('./brc39Encrypt')
    .then(({ abortBrc39EncryptInFlight }) => {
      abortBrc39EncryptInFlight()
    })
    .catch(() => {
      /* worker optional in tests */
    })
  let released = false
  return () => {
    if (released) return
    released = true
    inboundWalletRequests = Math.max(0, inboundWalletRequests - 1)
    syncPermissionSpendPriority()
  }
}

export function subscribePermissionRequests(cb: PromptListener): () => void {
  promptListeners.add(cb)
  cb(current?.request ?? null)
  return () => {
    promptListeners.delete(cb)
  }
}

export function subscribeConnectedApps(cb: ConnectedListener): () => void {
  connectedListeners.add(cb)
  cb(listConnectedApps())
  return () => {
    connectedListeners.delete(cb)
  }
}

/** @deprecated prefer subscribeConnectedApps */
export function subscribeAllowedOrigins(cb: (origins: string[]) => void): () => void {
  return subscribeConnectedApps((apps) => cb(apps.map((a) => a.origin)))
}

export function resolvePermission(id: number, decision: PermissionDecision, lifetime?: PermissionLifetime): boolean {
  // Atomic decision edge. UI removal happens on React's next render, so a
  // second tap can still call here with the stale prompt. Returning false lets
  // every surface suppress duplicate sounds/toasts and, most importantly,
  // prevents callers from presenting a second approval as successful.
  if (!current || current.request.id !== id) return false
  const prompt = current.request
  if (prompt.kind === 'action' && prompt.featureAccess && lifetime) prompt.permissionLifetime = lifetime
  const { resolve } = current
  current = null
  syncPermissionSpendPriority()
  void import('./appActivity').then(({ recordWalletEvent }) => {
    const name = appDisplayName(prompt.origin)
    if (prompt.kind === 'connect') {
      recordWalletEvent({
        origin: prompt.origin,
        method: decision === 'allow' ? 'connect' : 'connect-deny',
        note: decision === 'allow' ? `Connected ${name}` : `Denied ${name}`,
      })
      return
    }
    // Market and swap actions already write their own activity row with the
    // item. A second "Approved / App BRC Cloud" event hides the failure.
    if (
      prompt.kind === 'action' &&
      [
        'createMarketListingAdvert',
        'createCancelMarketListingAdvert',
        'purchaseMarketListing',
        'createMarketPurchaseIntent',
        'issueBntAsset',
        'mintBntAsset',
        'transferBntAsset',
        'sendCoins',
      ].includes(prompt.method)
    ) {
      return
    }
    recordWalletEvent({
      origin: prompt.origin,
      method: decision === 'allow' ? 'approve' : 'deny',
      note: prompt.title,
    })
  })
  void import('./diagnosticLog').then(({ logDiag }) => {
    const name = appDisplayName(prompt.origin)
    if (prompt.kind === 'connect') {
      logDiag('connect', decision === 'allow' ? 'info' : 'warn', decision, {
        app: name,
        origin: prompt.origin,
      })
      return
    }
    if (prompt.kind === 'action') {
      logDiag('permission', decision === 'allow' ? 'info' : 'warn', decision, {
        method: prompt.method,
        app: name,
        origin: prompt.origin,
      })
    }
  })
  const appName = appDisplayName(prompt.origin)
  if (prompt.kind === 'connect' && decision === 'allow') {
    if (prompt.spendingAuthorization && prompt.spendingAuthorization.amountSats > 0) {
      void import('./spendingAuthorization').then(({ grantSpendingAuthorization }) => {
        grantSpendingAuthorization(prompt.origin, prompt.spendingAuthorization!)
      })
      // Auto-pay may also be enabled on this Connect prompt — UI stores settings
      // via setAutoPaySettings after Authorize.
    }
    dispatchWalletUiEvent('handcash:wallet-connected', {
      origin: prompt.origin,
      appName,
    })
  } else {
    dispatchWalletUiEvent('handcash:permission-dismissed', {})
  }
  resolve(decision)
  pumpQueue()
  releasePromptFocusIfIdle()
  return true
}

/**
 * Nothing left to approve — give the desktop back to the app that asked.
 *
 * The prompt pulled the wallet in front of the browser; once it is answered
 * the user wants to watch the app continue, not find the wallet on top and
 * switch back by hand. The shell only acts when the prompt actually stole
 * focus, and the request keeps processing while the wallet is hidden.
 */
function releasePromptFocusIfIdle(): void {
  if (current || queue.length > 0) return
  try {
    void window.handcash?.releasePromptFocus?.()
  } catch {
    // Non-DOM environments (tests) — ignore.
  }
}

/** Drop every waiting connect/action prompt (HTTP timeout / client gone). */
export function cancelPendingPermissions(reason = 'cancelled'): void {
  void reason
  const waiting = [...queue]
  queue.length = 0
  if (current) {
    const { resolve } = current
    current = null
    resolve('deny')
  }
  for (const item of waiting) item.resolve('deny')
  syncPermissionSpendPriority()
  dispatchWalletUiEvent('handcash:permission-dismissed', {})
  notify()
}

export async function requestOriginPermission(
  origin: string | undefined,
  method: string,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)

  if (isOriginAllowed(key)) return 'allow'

  if (current?.request.kind === 'connect' && current.request.origin === key) {
    return new Promise((resolve) => {
      const prev = current!
      current = {
        request: prev.request,
        resolve: (decision) => {
          prev.resolve(decision)
          resolve(decision)
        },
      }
    })
  }

  const queued = queue.find(
    (item) => item.request.kind === 'connect' && item.request.origin === key,
  )
  if (queued) {
    return new Promise((resolve) => {
      const prevResolve = queued.resolve
      queued.resolve = (decision) => {
        prevResolve(decision)
        resolve(decision)
      }
    })
  }

  // Show Connect immediately — never await a remote manifest. A hung/slow
  // fetch (common on Android when explorers are timing out) used to delay the
  // prompt so waitForAuthentication looked broken.
  const decision = enqueuePrompt({
    id: idCounter++,
    kind: 'connect',
    origin: key,
    method,
    createdAt: Date.now(),
  })

  void (async () => {
    try {
      const { fetchAppSpendingAuthorization } = await import('./spendingAuthorization')
      const found = await fetchAppSpendingAuthorization(
        origin?.trim() || `https://${key}`,
      )
      if (!found) return
      const patch = (prompt: PendingPrompt): boolean => {
        if (prompt.kind !== 'connect' || prompt.origin !== key) return false
        prompt.spendingAuthorization = found
        return true
      }
      if (current?.request && patch(current.request)) {
        notify()
        return
      }
      for (const item of queue) {
        if (patch(item.request)) {
          notify()
          return
        }
      }
    } catch {
      // Connect works without a monthly grant label.
    }
  })()

  return decision
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

/** Canonical `txid.vout` for a held tip, or null when the app sent nonsense. */
function normalizeItemOutpoint(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase()
  const match = /^([0-9a-f]{64})[._](0|[1-9]\d*)$/.exec(raw)
  return match ? `${match[1]}.${match[2]}` : null
}

function firstInputOutpoint(body: Record<string, unknown>): string | undefined {
  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const outpoint = (raw as { outpoint?: unknown }).outpoint
    if (typeof outpoint === 'string' && outpoint.trim()) {
      return normalizeItemOutpoint(outpoint) ?? undefined
    }
  }
  return undefined
}

function tokenIdFromBody(body: Record<string, unknown>): string | undefined {
  const direct = body.origin ?? body.tokenId
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim().toLowerCase().replace('.', '_')
  }
  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const tags = Array.isArray((raw as { tags?: unknown }).tags)
      ? (raw as { tags: unknown[] }).tags
      : []
    for (const tag of tags) {
      if (typeof tag !== 'string') continue
      const m = /^origin:([0-9a-f]{64}[._]\d+)$/i.exec(tag.trim())
      if (m) return m[1].toLowerCase().replace('.', '_')
    }
  }
  return undefined
}

/** The supply line of a BNT token issue prompt: fixed, open, or capped. */
function bntIssueSupplyLine(body: Record<string, unknown>): string {
  const caps = [
    body.max != null ? `at most ${String(body.max)} units` : '',
    body.size != null ? `at most ${String(body.size)} items` : '',
  ].filter(Boolean)
  if (caps.length > 0) return `Capped supply: you can mint more, ${caps.join(' and ')}`
  return body.auth === true ? 'Open supply: you can mint more, with no cap' : 'Fixed supply: nothing more can ever be minted'
}

export function summarizeAction(method: string, args: unknown): {
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
  amountNote?: string
  /** What this payment counts against the app's Auto-pay / spending budget, in sats; defaults to `amountSats`. */
  budgetSats?: number
  itemOutpoint?: string
  tokenId?: string
  itemName?: string
  itemImageUrl?: string
  previewKind?: 'token' | 'collectable'
} {
  const body = asRecord(args)
  const details: string[] = []

  if (method === 'issueHandle') {
    const handle = typeof body.handle === 'string' ? body.handle : ''
    const identityKey = typeof body.identityKey === 'string' ? body.identityKey : ''
    const display = `@${handle}@${HOME_HANDLE_DOMAIN}`
    return {
      title: 'Issue a handle',
      summary: `Bind ${display} to your identity key`,
      details: [
        `Handle: ${display}`,
        `Owner key: ${identityKey.slice(0, 8)}…${identityKey.slice(-8)}`,
        'Spends the HandCash claim ticket the app holds for it',
        'One use; this approval expires two minutes after you approve',
      ],
    }
  }

  if (method === 'createAction' && isItemIssuanceArgs(method, args)) {
    const fungible = isTokenSpendArgs(method, args)
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : fungible
          ? 'Mint a token'
          : 'Mint a collectable'
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    const names = outputs.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const tags = (raw as { tags?: unknown }).tags
      if (!Array.isArray(tags)) return []
      const name = tags.find(
        (t): t is string => typeof t === 'string' && t.toLowerCase().startsWith('name:'),
      )
      return name ? [name.slice('name:'.length)] : []
    })
    for (const name of names) details.push(`Item: ${name}`)
    details.push(
      fungible
        ? 'Adds a new fungible token to your inventory'
        : 'Adds a new collectable to your inventory',
    )
    details.push('Not covered by Pay or Auto-pay')
    return {
      title: fungible ? 'Mint token' : 'Mint item',
      summary: description,
      details,
    }
  }

  if (method === 'createAction' && isTokenSpendArgs(method, args)) {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Send a token'
    details.push('Not covered by Pay or Auto-pay')
    return {
      title: 'Send token',
      summary: description,
      details,
      itemOutpoint: firstInputOutpoint(body),
      tokenId: tokenIdFromBody(body),
    }
  }

  if (method === 'createAction' && isItemSpendArgs(method, args)) {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Send a collectable'
    if (Array.isArray(body.labels) && body.labels.includes('1sat')) {
      details.push('Type: 1Sat')
    }
    details.push('Not covered by Pay or Auto-pay')
    return {
      title: 'Send item',
      summary: description,
      details,
      itemOutpoint: firstInputOutpoint(body),
    }
  }

  if (method === 'createAction') {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Payment from a connected app'
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    let total = 0
    for (const raw of outputs) {
      if (!raw || typeof raw !== 'object') continue
      const out = raw as Record<string, unknown>
      const sats = typeof out.satoshis === 'number' ? out.satoshis : 0
      total += sats
      const label =
        typeof out.outputDescription === 'string' && out.outputDescription
          ? out.outputDescription
          : 'Payment'
      if (sats > 0) details.push(`${label}: ${formatBsvSignificant(sats, 5)}`)
    }
    return {
      title: 'Approve payment',
      summary: description,
      amountSats: total > 0 ? total : undefined,
      amountLabel: total > 0 ? formatBsvSignificant(total, 5) : undefined,
      details,
    }
  }

  if (method === 'signAction' && isTokenSpendArgs(method, args)) {
    return {
      title: 'Confirm token send',
      summary: 'Finish signing a fungible token transfer',
      details: ['Not covered by Pay or Auto-pay'],
    }
  }

  if (method === 'signAction' && isItemSpendArgs(method, args)) {
    return {
      title: 'Confirm item send',
      summary: 'Finish signing a collectable transfer',
      details: ['Not covered by Pay or Auto-pay'],
    }
  }

  if (method === 'signAction') {
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    let total = 0
    const details: string[] = []
    for (const raw of outputs) {
      if (!raw || typeof raw !== 'object') continue
      const out = raw as Record<string, unknown>
      const sats = typeof out.satoshis === 'number' ? out.satoshis : 0
      total += sats
      const label =
        typeof out.outputDescription === 'string' && out.outputDescription
          ? out.outputDescription
          : 'Payment'
      if (sats > 0) details.push(`${label}: ${formatBsvSignificant(sats, 5)}`)
    }
    if (details.length > 0 || total > 0) {
      return {
        title: 'Confirm payment',
        summary: 'Finish signing a payment you already started',
        details,
        amountSats: total > 0 ? total : undefined,
        amountLabel: total > 0 ? formatBsvSignificant(total, 5) : undefined,
      }
    }
    return {
      title: 'Confirm payment',
      summary: 'Finish signing a payment you already started',
      details: [],
    }
  }

  if (method === 'internalizeAction' && isTokenReceiveArgs(method, args)) {
    details.push('Adds a fungible token to your inventory')
    return {
      title: 'Receive token',
      summary:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : 'Accept a token into this wallet',
      details,
    }
  }

  if (method === 'internalizeAction' && isItemReceiveArgs(method, args)) {
    if (Array.isArray(body.labels) && body.labels.includes('1sat')) {
      details.push('Type: 1Sat')
    }
    details.push('Adds a collectable to your inventory')
    return {
      title: 'Receive item',
      summary:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : 'Accept a collectable into this wallet',
      details,
    }
  }

  if (method === 'internalizeAction') {
    return {
      title: 'Accept incoming funds',
      summary: 'Add incoming coins to your HandCash wallet',
      details: typeof body.description === 'string' ? [body.description] : [],
    }
  }

  if (method === 'relinquishOutput' && isTokenSpendArgs(method, args)) {
    return {
      title: 'Release token',
      summary: 'Remove a fungible tip from wallet tracking',
      details: ['Not covered by Pay or Auto-pay'],
    }
  }

  if (method === 'relinquishOutput' && isItemSpendArgs(method, args)) {
    return {
      title: 'Release item',
      summary: 'Remove a collectable from wallet tracking',
      details: ['Not covered by Pay or Auto-pay'],
    }
  }

  if (method === 'encrypt') {
    return {
      title: 'Encrypt data',
      summary: 'Encrypt data with your wallet keys',
      details: [],
    }
  }

  if (method === 'decrypt') {
    return {
      title: 'Decrypt data',
      summary: 'Unlock encrypted data with your wallet keys',
      details: [],
    }
  }

  if (method === 'createSignature') {
    const purpose = walletIdentityProofPurpose(args)
    if (purpose) {
      return {
        title: 'Prove wallet identity',
        summary: purpose,
        details: [
          'Signs a short-lived challenge bound to this app',
          'Does not authorize a payment or reveal private keys',
        ],
      }
    }
    return {
      title: 'Sign with wallet',
      summary: 'Create a signature proving you control this wallet',
      details: [],
    }
  }

  if (method === 'createAdminIdentityProof') {
    return {
      title: 'Open transaction operations',
      summary: 'Prove this wallet is the configured operations administrator',
      details: [
        'Signs a short-lived handcash.io login challenge',
        'Does not authorize a payment or reveal private keys',
      ],
    }
  }

  if (method === 'createMarketListingAdvert') {
    const price = Math.max(0, Math.trunc(Number(body.priceSats) || 0))
    const label = (typeof body.name === 'string' && body.name.trim()) || 'item'
    return {
      title: `List ${label} for sale`,
      summary: 'Create an on-chain BRC-48 offer for this collectable',
      amountSats: price || undefined,
      amountLabel: price ? formatBsvSignificant(price, 5) : undefined,
      itemOutpoint: normalizeItemOutpoint(body.outpoint) ?? undefined,
      previewKind: 'collectable',
      details: [price ? `Price ${price.toLocaleString()} sats` : 'Price unset'],
    }
  }

  if (method === 'purchaseMarketListing') {
    const preview = marketListingPreviewFromArgs(args)
    const price = Math.max(
      0,
      Math.trunc(
        Number(
          body.priceSats ??
            (body.listing && typeof body.listing === 'object'
              ? (body.listing as Record<string, unknown>).priceSats
              : 0),
        ) || 0,
      ),
    )
    const bought = preview?.itemName
    return {
      title: bought ? `Buy ${bought}` : 'Buy market item',
      summary: bought
        ? `Buy ${bought}`
        : 'Authorize one atomic item purchase',
      amountSats: price || undefined,
      amountLabel: price ? formatBsvSignificant(price, 5) : undefined,
      itemOutpoint: preview?.itemOutpoint,
      itemName: preview?.itemName,
      itemImageUrl: preview?.itemImageUrl,
      previewKind: preview?.previewKind,
      details: [
        'Total includes the 5% market fee',
        'No payment is sent unless the exact item settlement can complete',
      ],
    }
  }

  if (method === 'createMarketPurchaseIntent') {
    const preview = marketListingPreviewFromArgs(args)
    const listing =
      body.listing && typeof body.listing === 'object'
        ? (body.listing as Record<string, unknown>)
        : {}
    const price = Math.max(0, Math.trunc(Number(listing.priceSats) || 0))
    return {
      title: 'Approve market purchase',
      summary: preview?.itemName
        ? `Sign intent to buy ${preview.itemName} for ${price.toLocaleString()} sats`
        : `Sign an intent to buy this item for ${price.toLocaleString()} sats`,
      itemOutpoint: preview?.itemOutpoint,
      itemName: preview?.itemName,
      itemImageUrl: preview?.itemImageUrl,
      previewKind: preview?.previewKind,
      details: ['The signed intent binds the listing, price, fee, and BRC-150 proof.'],
    }
  }

  if (method === 'createCancelMarketListingAdvert') {
    return {
      title: 'Cancel market listing',
      summary: 'Spend the on-chain offer token to cancel this listing',
      details: [
        typeof body.outpoint === 'string'
          ? `Item: ${body.outpoint}`
          : 'Unknown item',
      ],
    }
  }







  if (method === 'issueBntAsset') {
    const kind = body.kind === 'item' ? 'item' : 'token'
    const label =
      kind === 'item'
        ? typeof body.name === 'string' ? body.name : 'item'
        : `${String(body.supply ?? '?')} ${typeof body.sym === 'string' ? body.sym : 'tokens'}`
    return {
      title: `Issue ${label}`,
      summary: `Deploy an open ${kind} you issue and hold; it moves on its holder's signature alone`,
      itemName: label,
      previewKind: kind === 'item' ? 'collectable' : 'token',
      details: [
        'Anyone can check it back to your deploy without an indexer',
        typeof body.collection === 'string' ? `Collection: ${body.collection}` : kind === 'item' ? 'No collection' : bntIssueSupplyLine(body),
      ],
    }
  }

  if (method === 'mintBntAsset') {
    return {
      title: `Mint ${bntAmountLabel(body.assetId, body.amount)}`,
      summary: 'Create new units of a token you issued. They come to you; a capped token never passes its cap.',
      tokenId: typeof body.assetId === 'string' ? body.assetId : undefined,
      previewKind: 'token',
      details: [typeof body.assetId === 'string' ? `Asset: ${body.assetId}` : 'Unknown asset'],
    }
  }

  if (method === 'transferBntAsset') {
    const recipient = typeof body.recipient === 'string' ? body.recipient : ''
    return {
      title: `Send ${bntAmountLabel(body.assetId, body.amount ?? '1')}`,
      summary: 'You sign the transfer; the recipient gets its proof in their inbox and checks it themselves.',
      tokenId: typeof body.assetId === 'string' ? body.assetId : undefined,
      details: [
        typeof body.assetId === 'string' ? `Asset: ${body.assetId}` : 'Unknown asset',
        recipient ? `To: ${recipient.slice(0, 16)}…` : 'Unknown recipient',
      ],
    }
  }

  if (method === 'sendCoins' && isCoinChain(body.chain)) {
    const chain = body.chain
    const { label, ticker } = COIN_INFO[chain]
    const raw = String(body.amount ?? '')
    const units = /^\d+$/.test(raw) ? BigInt(raw) : null
    const address = typeof body.address === 'string' ? body.address : ''
    const identityKey = typeof body.identityKey === 'string' ? body.identityKey.trim() : ''
    const usd = units ? coinUsdValue(chain, units) : null
    return {
      title: coinApprovalTitle(chain),
      summary:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : 'Payment from a connected app',
      amountLabel: units ? `${formatCoin(chain, units)} ${ticker}` : undefined,
      amountNote: usd != null ? formatUsd(usd) : undefined,
      budgetSats: units ? coinBudgetSats(chain, units) ?? undefined : undefined,
      details: [
        identityKey ? `To identity: ${identityKey.slice(0, 16)}…` : address ? `To: ${address}` : 'Unknown address',
        ...(identityKey ? [`Their wallet receives ${label} at its identity; it is told which key the coins are locked to`] : []),
        `Paid on ${label} from this wallet; the ${label} network fee is added on top`,
        'Counts toward this app\'s Auto-pay limit at its dollar value',
      ],
    }
  }

  if (method === 'sendArcUsd') {
    const raw = String(body.amount ?? body.litoshi ?? '')
    const units = /^\d+$/.test(raw) ? BigInt(raw) : null
    const address = typeof body.address === 'string' ? body.address : ''
    const usd = units != null ? Number(units) / 1e6 : null
    return {
      title: 'Approve USDC payment',
      summary:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : 'Payment from a connected app',
      amountLabel: units != null ? `${(Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC` : undefined,
      amountNote: usd != null ? formatUsd(usd) : undefined,
      budgetSats: usd != null ? Math.round(usd * 1e8) : undefined,
      details: [
        address ? `To: ${address}` : 'Unknown address',
        'Paid as USDC on Arc from this wallet; the Arc network fee is added on top',
        "Counts toward this app's Auto-pay limit at its dollar value",
      ],
    }
  }

  if (method === 'executeArcUsdcFractionalize') {
    const atoms = String(body.atoms ?? '')
    const units = /^\d+$/.test(atoms) ? BigInt(atoms) : null
    return {
      title: 'Wrap USDC',
      summary: 'Credit BSV claim units from a USDC deposit on Arc (Labs)',
      amountLabel:
        units != null
          ? `${(Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`
          : undefined,
      details: [
        typeof body.txHash === 'string' ? `Deposit: ${body.txHash.slice(0, 18)}…` : 'Deposit tx required',
        'Lab wrap: verifies the Arc Transfer and credits a local claim ledger',
      ],
    }
  }

  if (method === 'executeArcUsdcRedeem') {
    const atoms = String(body.atoms ?? '')
    const units = /^\d+$/.test(atoms) ? BigInt(atoms) : null
    const to = typeof body.to === 'string' ? body.to : ''
    return {
      title: 'Redeem USDC wrap',
      summary: 'Burn claim units and pay USDC on Arc (Labs)',
      amountLabel:
        units != null
          ? `${(Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`
          : undefined,
      details: [
        to ? `To: ${to}` : 'Payout address required',
        'Lab redeem: spends held wrap claims and pays USDC on Arc',
      ],
    }
  }





  if (method.startsWith('reveal')) {
    return {
      title: 'Share key details',
      summary: 'Reveal advanced key linkage information to this app',
      details: [],
    }
  }

  return {
    title: 'Approve request',
    summary: 'This app needs permission to continue',
    details: [],
  }
}

function rememberItemActionGrant(
  origin: string,
  method: string,
  args: unknown,
): void {
  if (isItemReceiveArgs(method, args) || isTokenReceiveArgs(method, args)) {
    patchItemAccess(origin, (cur) => ({ ...cur, canReceive: true }))
  }
}

/** Trusted feature consent reuses the same Aeon decision queue on both shells. */
export async function requestFeatureApproval(feature: { origin: string; capabilities: string[]; details: string[]; grouped: boolean }, signal: AbortSignal): Promise<PermissionLifetime | null> {
  if (signal.aborted || promptListeners.size === 0 || queue.length + (current ? 1 : 0) >= 64) return null
  const prompt: PendingAction = { id: idCounter++, kind: 'action', origin: normalizeOrigin(feature.origin), method: 'getPublicKey',
    title: feature.grouped ? 'App feature access' : 'Wallet feature access',
    summary: 'Allow the displayed app capabilities. Session access lasts up to 30 minutes and ends on lock, account change or revocation. Remembered grants create on-chain tokens and transaction/service fees may apply.',
    details: feature.details, featureAccess: { capabilities: feature.capabilities, grouped: feature.grouped }, createdAt: Date.now() }
  const cancel = () => {
    if (current?.request.id === prompt.id) { const item = current; current = null; item.resolve('deny') }
    else { const index = queue.findIndex(item => item.request.id === prompt.id); if (index !== -1) queue.splice(index, 1)[0]!.resolve('deny') }
    pumpQueue(); dispatchWalletUiEvent('handcash:permission-dismissed', {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 120_000)
  try { return await enqueuePrompt(prompt) === 'allow' && !signal.aborted ? prompt.permissionLifetime ?? 'session' : null }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
}

/** ECPM never inherits Connect, identity-proof, Pay or Auto-pay approval. */
export async function requestEcpmApproval(request: EcpmAuthorizationRequest, signal: AbortSignal): Promise<boolean> {
  if (request.seekPermission === false || signal.aborted || promptListeners.size === 0 || queue.length + (current ? 1 : 0) >= 64) return false
  const id = idCounter++
  const cancel = () => {
    if (current?.request.id === id) {
      const item = current
      current = null
      item.resolve('deny')
    } else {
      const index = queue.findIndex(item => item.request.id === id)
      if (index !== -1) queue.splice(index, 1)[0]!.resolve('deny')
    }
    pumpQueue()
    dispatchWalletUiEvent('handcash:permission-dismissed', {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, 120_000)
  try {
    return await enqueuePrompt({
      id, kind: 'action', origin: normalizeOrigin(request.originator), method: 'getPublicKey',
      title: 'Point masking',
      featureAccess: { capabilities: ['Use a protected wallet key for the displayed ECPM operation.'], singleRequest: true },
      summary: 'Apply or remove a mask for this operation only. Your private key stays in the wallet. Protected-key unlock policy still applies.',
      // Both existing Aeon surfaces show two detail rows. Include the complete
      // consent scope in those rows instead of truncating security information.
      details: [
        `Protocol: ${request.logicalProtocolID}; security level: ${request.securityLevel}; counterparty scope: ${request.securityLevel === 1 ? 'all counterparties' : request.counterparty}`,
        `First key ID: ${request.keyID}; operation: ${request.operation}; point: ${request.point}; privileged: ${request.privileged ? 'yes' : 'no'}${request.privileged ? `; reason: ${request.privilegedReason}` : ''}`
      ],
      createdAt: Date.now()
    }) === 'allow' && !signal.aborted
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}

export function requestActionApproval(
  origin: string | undefined,
  method: string,
  args: unknown,
  onAutomaticApproval?: (reservation: AutoPayReservation) => void,
  bridgeRequestId?: number,
  attestation?: IssuanceAttestation,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const { title, summary, details, amountLabel, amountSats, amountNote, budgetSats, itemOutpoint, tokenId, itemName, itemImageUrl, previewKind } =
    summarizeAction(method, args)
  const spendSats = budgetSats ?? amountSats
  const inputs = asRecord(args).inputs
  const issuance: PendingAction['issuance'] =
    attestation?.kind === 'signed'
      ? {
          kind: 'signed',
          identityKey: attestation.identityKey,
          ...(attestation.displayName ? { displayName: attestation.displayName } : {}),
          anchor: !Array.isArray(inputs) || inputs.length === 0,
        }
      : attestation?.kind === 'unsigned'
        ? { kind: 'unsigned' }
        : undefined
  const itemSpend =
    isItemSpendArgs(method, args) ||
    isTokenSpendArgs(method, args)
  const itemReceive = isItemReceiveArgs(method, args) || isTokenReceiveArgs(method, args)
  const incomingFunds = method === 'internalizeAction' && !itemReceive

  // Item send / receive and anything signed by an issuer identity are never
  // covered by Pay or Auto-pay. Send / mint always prompt; receive may reuse a
  // prior grant.
  if (itemSpend || issuance) {
    // fall through to prompt
  } else if (itemReceive) {
    const access = getItemAccess(key)
    if (access.canReceive) return Promise.resolve('allow')
  } else if (incomingFunds && acceptsIncomingFunds(key)) {
    return Promise.resolve('allow')
  } else if (onAutomaticApproval && canAutoProcessPayment(key, method, spendSats)) {
    const reservation = reserveAutoPayPayment(key, spendSats ?? 0)
    if (reservation) {
      onAutomaticApproval(reservation)
      return Promise.resolve('allow')
    }
  }

  // After Connect authorize, skip a second popup for identity proofs in the same flow.
  if (isIdentityProofMethod(method) && wasRecentlyConnected(key)) {
    sessionApprovedProofs.add(proofGrantKey(key, method))
    return Promise.resolve('allow')
  }

  // Same session: user already approved this proof once for this app.
  if (isIdentityProofMethod(method) && sessionApprovedProofs.has(proofGrantKey(key, method))) {
    return Promise.resolve('allow')
  }

  return enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    bridgeRequestId,    origin: key,
    method,
    title,
    summary,
    details,
    amountLabel,
    amountSats,
    ...(amountNote ? { amountNote } : {}),
    itemOutpoint,
    tokenId,
    itemName,
    itemImageUrl,
    previewKind,
    ...(issuance ? { issuance } : {}),
    createdAt: Date.now(),
  }).then((decision) => {
    if (decision === 'allow' && isIdentityProofMethod(method)) {
      sessionApprovedProofs.add(proofGrantKey(key, method))
    }
    if (decision === 'allow' && (itemSpend || itemReceive)) {
      rememberItemActionGrant(key, method, args)
    }
    return decision
  })
}

export class WalletPaymentDenied extends Error {
  constructor(title: string) {
    super(`${title} was not approved`)
    this.name = 'WalletPaymentDenied'
  }
}

/**
 * A payment the wallet makes on its own behalf (outside Send) takes the same
 * approval prompt an app's payment does. Never covered by Pay or auto-pay.
 */
export async function approveWalletPayment(args: {
  title: string
  summary: string
  amountSats: number
  details?: string[]
}): Promise<void> {
  const decision = await enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    origin: 'handcash.io',
    method: 'walletPayment',
    title: args.title,
    summary: args.summary,
    details: args.details ?? [],
    amountSats: args.amountSats,
    createdAt: Date.now(),
  })
  console.info(`[approval] ${args.title} ${args.amountSats} sats ${decision}`)
  if (decision !== 'allow') throw new WalletPaymentDenied(args.title)
}

function summarizeItemView(request: ItemViewRequest): {
  title: string
  summary: string
  details: string[]
} {
  const details: string[] = ['Not covered by Pay or wallet activity']
  if (request.wantsAll) {
    return {
      title: 'View items',
      summary: 'See collectables in this wallet',
      details: [...details, 'All collections and creators'],
    }
  }
  for (const c of request.collections) details.push(`Collection: ${c}`)
  for (const a of request.apps) details.push(`App: ${a}`)
  for (const c of request.creators) details.push(`Creator: ${c}`)
  for (const id of request.ids) details.push(`Item id: ${id}`)
  return {
    title: 'View items',
    summary: 'See specific collectables in this wallet',
    details,
  }
}

async function listHeldOutputs(basket: string): Promise<unknown[]> {
  // Permission copy is a projection, never a custody decision. The inventory
  // modules already reconcile Toolbox into an account-scoped durable paint and
  // maintain keyed in-memory indexes. Starting an uninterruptible basket scan
  // here used to keep the single Toolbox storage lock for 26–51 seconds even
  // after the prompt's timeout had fired, putting the next send in Preparing.
  const { heldInventoryOutputs } = await import('./inventoryProjection')
  return heldInventoryOutputs(basket)?.outputs ?? []
}

async function thirdPartyItemViewRequest(
  request: ItemViewRequest,
): Promise<{ request: ItemViewRequest; names: string[] }> {
  if (!request.wantsAll && request.scope !== 'plain') {
    return { request, names: request.collections }
  }
  const outputs = await listHeldOutputs('1sat')
  const { collections, apps } = grantableCollectionIdsFromOutputs(outputs)
  const named = grantableCollectionsFromOutputs(outputs)
  return {
    request: {
      scope: collections.length ? 'collection' : apps.length ? 'app' : 'collection',
      collections,
      apps,
      creators: [],
      ids: [],
      wantsAll: false,
    },
    names: named.map((row) => row.name),
  }
}

async function thirdPartyTokenViewRequest(
  request: TokenViewRequest,
): Promise<{ request: TokenViewRequest; tickers: string[] }> {
  if (!request.wantsAll && request.scope === 'token' && request.ids.length > 0) {
    return { request, tickers: request.ids }
  }
  const outputs = await listHeldOutputs('bntft')
  const tokens = grantableTokensFromOutputs(outputs)
  return {
    request: {
      scope: 'token',
      ids: tokens.map((t) => t.id),
      keys: [],
      wantsAll: false,
    },
    tickers: tokens.map((t) => t.ticker),
  }
}

function summarizeFilteredItemView(names: string[]): {
  title: string
  summary: string
  details: string[]
} {
  const details = ['Not covered by Pay or wallet activity', 'Limited to collections you approve']
  for (const name of names.slice(0, 24)) details.push(`Collection: ${name}`)
  if (names.length === 0) details.push('No named collections in this wallet')
  return {
    title: 'View items',
    summary: 'See specific collectables in this wallet',
    details,
  }
}

function summarizeTokenView(tickers: string[], wantsAll: boolean): {
  title: string
  summary: string
  details: string[]
} {
  const details = ['Not covered by Pay, item view, or wallet activity']
  if (wantsAll && tickers.length === 0) {
    details.push('All tokens')
  }
  for (const ticker of tickers.slice(0, 24)) details.push(`Token: ${ticker}`)
  if (tickers.length === 0) details.push('No tokens in this wallet')
  return {
    title: 'View tokens',
    summary: 'See the tokens in this wallet',
    details,
  }
}

/**
 * Gate listOutputs against item baskets. Pay does not include inventory access.
 * Returns allow/deny; caller should filter results when grant is filtered.
 * First Allow persists on the originator (creating the connected row if needed)
 * so catalog reloads and reconnects do not re-prompt. Send/list/buy
 * still prompt. Market catalog Allow is durable view=all.
 */
export async function requestItemViewApproval(
  origin: string | undefined,
  args: unknown,
  preparedRequest?: ItemViewRequest,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const body = asRecord(args)
  if (!isItemBasket(body.basket)) return 'allow'

  const original = preparedRequest ?? parseItemViewRequest(args)
  const thirdParty = isThirdPartyOriginator(origin)
  const catalog = isHandCashCatalogOrigin(origin)
  // Grant first: an origin already allowed answers from memory, never from a
  // basket read. The read below only names what a *new* prompt offers.
  const access = getItemAccess(origin)
  if (itemViewGranted(access, original)) return 'allow'
  // BRC-165 `id` is a narrow row lookup, not inventory access. Record only
  // this id-scoped grant so response filtering can enforce the same ceiling.
  if (original.scope === 'id' && !original.wantsAll) {
    patchItemAccess(origin, (cur) =>
      mergeItemViewGrant(cur, original, { allowAll: catalog || !thirdParty }),
    )
    return 'allow'
  }
  let promptNames: string[] | undefined
  let granted = original
  if (thirdParty && (original.wantsAll || original.scope === 'plain')) {
    const converted = await thirdPartyItemViewRequest(original)
    promptNames = converted.names
    granted = converted.request
  }

  const { title, summary, details } = promptNames
    ? summarizeFilteredItemView(promptNames)
    : summarizeItemView(original)

  const grant = (decision: PermissionDecision) => {
    if (decision === 'allow') {
      patchItemAccess(origin, (cur) =>
        mergeItemViewGrant(cur, granted, { allowAll: catalog || !thirdParty }),
      )
    }
    return decision
  }

  if (
    current?.request.kind === 'action' &&
    current.request.origin === key &&
    current.request.method === 'listOutputs'
  ) {
    return new Promise((resolve) => {
      const prev = current!
      current = {
        request: prev.request,
        resolve: (decision) => {
          prev.resolve(grant(decision))
          resolve(decision)
        },
      }
    })
  }

  return enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    origin: key,
    method: 'listOutputs',
    title,
    summary,
    details,
    createdAt: Date.now(),
  }).then(grant)
}

export async function requestTokenViewApproval(
  origin: string | undefined,
  args: unknown,
  preparedRequest?: TokenViewRequest,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const body = asRecord(args)
  if (!isTokenViewBasket(body.basket)) return 'allow'

  const original = preparedRequest ?? parseTokenViewRequest(args)
  const thirdParty = isThirdPartyOriginator(origin)
  const catalog = isHandCashCatalogOrigin(origin)
  // Grant first: an origin already allowed answers from memory, never from a
  // basket read. The read below only names what a *new* prompt offers.
  const access = getTokenAccess(origin)
  if (tokenViewGranted(access, original)) return 'allow'
  // BRC-165 `id` is a narrow row lookup, not inventory access, as for items.
  if (original.scope === 'id') {
    patchTokenAccess(origin, (cur) =>
      mergeTokenViewGrant(cur, original, { allowAll: catalog || !thirdParty }),
    )
    return 'allow'
  }
  let tickers: string[] = original.ids
  // A third-party "all" is granted as the tokens the prompt names; storing the
  // request itself left a filtered grant naming nothing.
  let granted = original
  if (thirdParty && (original.wantsAll || original.scope === 'plain')) {
    const converted = await thirdPartyTokenViewRequest(original)
    tickers = converted.tickers
    granted = converted.request
  }

  const { title, summary, details } = summarizeTokenView(tickers, original.wantsAll)

  const grant = (decision: PermissionDecision) => {
    if (decision === 'allow') {
      patchTokenAccess(origin, (cur) =>
        mergeTokenViewGrant(cur, granted, { allowAll: catalog || !thirdParty }),
      )
    }
    return decision
  }

  if (
    current?.request.kind === 'action' &&
    current.request.origin === key &&
    current.request.method === 'listOutputs'
  ) {
    return new Promise((resolve) => {
      const prev = current!
      current = {
        request: prev.request,
        resolve: (decision) => {
          prev.resolve(grant(decision))
          resolve(decision)
        },
      }
    })
  }

  return enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    origin: key,
    method: 'listOutputs',
    title,
    summary,
    details,
    createdAt: Date.now(),
  }).then(grant)
}

/**
 * `p iptft …` / `p iptnft …` inventory view. One grant per profile covers
 * every scope; `id` is a narrow row lookup and, as for items and tokens, never prompts.
 */
export async function requestCountersignedViewApproval(
  origin: string | undefined,
  request: CountersignedViewRequest,
): Promise<PermissionDecision> {
  const { idx, apps } = findConnectedApp(origin)
  if (idx >= 0 && apps[idx]?.countersignedViews?.includes(request.scheme)) return 'allow'
  if (request.scope === 'id' || !isThirdPartyOriginator(origin)) return 'allow'
  const key = normalizeOrigin(origin)
  const what = request.scheme === 'iptft' ? 'tokens' : 'items'
  return enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    origin: key,
    method: 'listOutputs',
    title: `View issuer-accepted ${what}`,
    summary: `Let this app see the issuer-accepted ${what} you hold`,
    details: [
      'Read only: the app cannot move them',
      'Every transfer still needs your approval and the issuer’s countersignature',
    ],
    createdAt: Date.now(),
  }).then((decision) => {
    if (decision === 'allow') {
      const found = ensureConnectedApp(origin)
      const copy = [...found.apps]
      const granted = copy[found.idx]!.countersignedViews ?? []
      copy[found.idx] = {
        ...copy[found.idx]!,
        countersignedViews: granted.includes(request.scheme) ? granted : [...granted, request.scheme],
      }
      writeConnected(copy)
    }
    return decision
  })
}

/** Filter listOutputs payload to what the app's item grant allows. */
export function filterItemOutputsForOrigin(
  origin: string | undefined,
  result: unknown,
  request?: ItemViewRequest,
): unknown {
  const access = getItemAccess(origin)
  const thirdParty = isThirdPartyOriginator(origin)
  if (access.view === 'none') {
    if (!result || typeof result !== 'object') return { outputs: [], totalOutputs: 0 }
    const body = result as { outputs?: unknown[] }
    return { ...body, outputs: [], totalOutputs: 0 }
  }
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[]; totalOutputs?: number }
  if (!Array.isArray(body.outputs)) return result
  const passGrant = access.view === 'all' && (!request || request.wantsAll)
  const outputs = body.outputs.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const o = raw as { tags?: string[]; customInstructions?: string; lockingScript?: unknown }
    if (thirdParty && isLeftoverThirdPartyItem(o)) return false
    if (passGrant) return true
    return outputMatchesItemAccess(access, o.tags, o.customInstructions, request, o.lockingScript)
  })
  return {
    ...body,
    outputs,
    totalOutputs: outputs.length,
  }
}

export function filterTokenOutputsForOrigin(
  origin: string | undefined,
  result: unknown,
  request?: TokenViewRequest,
): unknown {
  const access = getTokenAccess(origin)
  const thirdParty = isThirdPartyOriginator(origin)
  if (access.view === 'none') {
    if (!result || typeof result !== 'object') return { outputs: [], totalOutputs: 0 }
    const body = result as { outputs?: unknown[] }
    return { ...body, outputs: [], totalOutputs: 0 }
  }
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[]; totalOutputs?: number }
  if (!Array.isArray(body.outputs)) return result
  const passGrant = access.view === 'all' && (!request || request.wantsAll)
  const outputs = body.outputs.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const o = raw as {
      tags?: string[]
      customInstructions?: string
      lockingScript?: unknown
      outpoint?: string
    }
    if (thirdParty && isRetiredFungibleRow(o)) return false
    if (passGrant) return true
    return outputMatchesTokenAccess(
      access,
      o.tags,
      o.customInstructions,
      request,
      o.lockingScript,
      o.outpoint,
    )
  })
  return {
    ...body,
    outputs,
    totalOutputs: outputs.length,
  }
}

export async function gateOriginAccess(
  origin: string | undefined,
  method: string,
  channel: BridgeChannel = 'socket',
): Promise<'allow' | 'deny' | 'unauthenticated'> {
  if (isPublicMethod(method)) return 'allow'

  if (isSilentAuthMethod(method)) {
    return isOriginAllowed(origin) ? 'allow' : 'unauthenticated'
  }

  if (isOriginAllowed(origin)) return 'allow'

  const decision = await requestOriginPermission(origin, method)
  if (decision === 'allow') {
    allowOrigin(origin, channel)
    return 'allow'
  }
  return isConnectMethod(method) ? 'unauthenticated' : 'deny'
}
