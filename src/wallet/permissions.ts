import {
  appDisplayName,
  normalizeAppHost,
} from './appIdentity'
import { canAutoProcessPayment, clearAutoPaySettings } from './autoPay'
import {
  DEFAULT_ITEM_ACCESS,
  DEFAULT_TOKEN_ACCESS,
  grantableCollectionIdsFromOutputs,
  grantableCollectionsFromOutputs,
  grantableTokensFromOutputs,
  isBsv21ReceiveArgs,
  isBsv21SpendArgs,
  isColourIssuanceArgs,
  isColourSpendArgs,
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
  isOnesatFtLeftoverRow,
  outputMatchesItemAccess,
  outputMatchesTokenAccess,
  parseItemViewRequest,
  parseTokenViewRequest,
  tokenViewGranted,
  type ItemAccess,
  type ItemViewRequest,
  type TokenAccess,
  type TokenViewRequest,
} from './itemAccess'
import { formatBsvSignificant, getActiveWallet } from './session'
import {
  bsv21IdentityMintHints,
  isBsv21IdentityMintArgs,
} from './bsv21Issuer'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { walletIdentityProofPurpose } from './walletIdentityProof'

const STORAGE_KEY = 'handcash.brc100.connectedApps'

export type PermissionDecision = 'allow' | 'deny'

export type ConnectedApp = {
  origin: string
  name: string
  connectedAt: number
  /** Collectable / NFT capabilities — never implied by Pay. */
  itemAccess?: ItemAccess
  /** BSV-21 token view — never implied by item view. */
  tokenAccess?: TokenAccess
}

export type PendingPermission = {
  id: number
  kind: 'connect'
  origin: string
  method: string
  createdAt: number
}

export type PendingAction = {
  id: number
  kind: 'action'
  origin: string
  method: string
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
  /**
   * Held tip this action would sell. The prompt resolves the picture and name
   * from the wallet's own basket — an app may name an outpoint, it never gets
   * to describe what the user is about to approve.
   */
  itemOutpoint?: string
  /** BSV-21 token id when this action spends or lists a fungible tip. */
  tokenId?: string
  createdAt: number
}

export type PendingPrompt = PendingPermission | PendingAction

type PromptListener = (pending: PendingPrompt | null) => void
type ConnectedListener = (apps: ConnectedApp[]) => void

const PUBLIC_METHODS = new Set([
  'getVersion',
  'getNetwork',
  'getHeight',
  'getHeaderForHeight',
  'health',
])

const SILENT_AUTH_METHODS = new Set(['isAuthenticated'])
const CONNECT_METHODS = new Set(['waitForAuthentication'])

const ACTION_METHODS = new Set([
  'createAction',
  'signAction',
  'internalizeAction',
  'relinquishOutput',
  'relinquishCertificate',
  'createSignature',
  'createMarketListingAdvert',
  'createMarketPurchaseIntent',
  'purchaseMarketListing',
  'createCancelMarketListingAdvert',
  'encrypt',
  'decrypt',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'proveCertificate',
  'acquireCertificate',
])

/**
 * Every request in this set describes a distinct signature or chain mutation.
 * Never let one prompt authorize another waiter merely because method + origin
 * match: two listing requests can name different items or prices.
 */
const NO_COALESCE_ACTIONS = new Set([
  'createSignature',
  'createMarketListingAdvert',
  'createMarketPurchaseIntent',
  'purchaseMarketListing',
  'createCancelMarketListingAdvert',
])

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
          name: typeof a.name === 'string' && a.name ? a.name : appDisplayName(a.origin),
          connectedAt: typeof a.connectedAt === 'number' ? a.connectedAt : Date.now(),
          itemAccess: a.itemAccess ? normalizeItemAccess(a.itemAccess) : undefined,
          tokenAccess: a.tokenAccess ? normalizeTokenAccess(a.tokenAccess) : undefined,
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
  // Prefer durable / new key; fall back to legacy allowlist key.
  const next = durableGetItem(STORAGE_KEY)
  if (next) return migrateRaw(next)
  const legacy = durableGetItem('handcash.brc100.allowedOrigins')
  if (legacy) {
    const apps = migrateRaw(legacy)
    writeConnected(apps)
    return apps
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
    STORAGE_KEY,
    JSON.stringify([...dedup.values()]),
  )
  emitConnected()
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
  const focus = () => {
    if (typeof window !== 'undefined') {
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
    try {
      document.dispatchEvent(
        new CustomEvent('handcash:permission-request', {
          detail: {
            kind: prompt.kind,
            origin: prompt.origin,
            title: prompt.kind === 'action' ? prompt.title : 'Connect request',
          },
        }),
      )
    } catch {
      // Non-DOM environments (tests) — ignore.
    }
  }
}

/**
 * While a connect/pay prompt is open, yield the wallet FIFO the same way a
 * queued spend does — so BRC-39 encrypt/upload cannot sit ahead of Approve.
 */
let releasePermissionSpendPriority: (() => void) | null = null
function syncPermissionSpendPriority(): void {
  void import('./walletCoordinator')
    .then(({ requestSpendPriority }) => {
      // Re-read intent inside the callback: the prompt may have resolved while
      // the dynamic import was in flight.
      const want = current != null || queue.length > 0
      if (want && !releasePermissionSpendPriority) {
        releasePermissionSpendPriority = requestSpendPriority('permission-prompt')
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
  return PUBLIC_METHODS.has(method)
}

export function isSilentAuthMethod(method: string): boolean {
  return SILENT_AUTH_METHODS.has(method)
}

export function isConnectMethod(method: string): boolean {
  return CONNECT_METHODS.has(method)
}

export function isActionMethod(method: string): boolean {
  return ACTION_METHODS.has(method)
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

export function normalizeOrigin(origin: string | undefined): string {
  return normalizeAppHost(origin)
}

export function isOriginAllowed(origin: string | undefined): boolean {
  const key = normalizeOrigin(origin)
  return readConnected().some((a) => a.origin === key)
}

export function listConnectedApps(): ConnectedApp[] {
  return readConnected()
}

/** @deprecated prefer listConnectedApps */
export function listAllowedOrigins(): string[] {
  return readConnected().map((a) => a.origin)
}

export function allowOrigin(origin: string | undefined): void {
  const key = normalizeOrigin(origin)
  const prior = readConnected().find((a) => a.origin === key)
  const existing = readConnected().filter((a) => a.origin !== key)
  writeConnected([
    {
      origin: key,
      name: appDisplayName(key),
      connectedAt: prior?.connectedAt ?? Date.now(),
      // Connect does not grant item view/send/receive — those are approved per request.
      itemAccess: prior?.itemAccess,
      tokenAccess: prior?.tokenAccess,
    },
    ...existing,
  ])
  markRecentlyConnected(key)
}

export function getItemAccess(origin: string | undefined): ItemAccess {
  const key = normalizeOrigin(origin)
  const app = readConnected().find((a) => a.origin === key)
  return normalizeItemAccess(app?.itemAccess)
}

export function getTokenAccess(origin: string | undefined): TokenAccess {
  const key = normalizeOrigin(origin)
  const app = readConnected().find((a) => a.origin === key)
  return normalizeTokenAccess(app?.tokenAccess)
}

function patchItemAccess(
  origin: string | undefined,
  patch: (current: ItemAccess) => ItemAccess,
): ItemAccess {
  const key = normalizeOrigin(origin)
  const apps = readConnected()
  const idx = apps.findIndex((a) => a.origin === key)
  if (idx < 0) return DEFAULT_ITEM_ACCESS
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
  const key = normalizeOrigin(origin)
  const apps = readConnected()
  const idx = apps.findIndex((a) => a.origin === key)
  if (idx < 0) return DEFAULT_TOKEN_ACCESS
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
  clearPermissionSession()
}

/** True when a connect/pay/sign prompt is showing or queued — heavy sync must yield. */
export function hasPendingPermissionPrompt(): boolean {
  return current != null || queue.length > 0
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

export function resolvePermission(id: number, decision: PermissionDecision): boolean {
  // Atomic decision edge. UI removal happens on React's next render, so a
  // second tap can still call here with the stale prompt. Returning false lets
  // every surface suppress duplicate sounds/toasts and, most importantly,
  // prevents callers from presenting a second approval as successful.
  if (!current || current.request.id !== id) return false
  const prompt = current.request
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
    // Market list/buy/cancel already write their own activity row with the
    // item. A second "Approved / App BRC Cloud" event hides the failure.
    if (
      prompt.kind === 'action' &&
      [
        'createMarketListingAdvert',
        'createCancelMarketListingAdvert',
        'purchaseMarketListing',
        'createMarketPurchaseIntent',
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
  resolve(decision)
  pumpQueue()
  return true
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
  notify()
}

export function requestOriginPermission(origin: string | undefined, method: string): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)

  if (isOriginAllowed(key)) return Promise.resolve('allow')

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

  return enqueuePrompt({
    id: idCounter++,
    kind: 'connect',
    origin: key,
    method,
    createdAt: Date.now(),
  })
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

export function summarizeAction(method: string, args: unknown): {
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
  itemOutpoint?: string
  tokenId?: string
} {
  const body = asRecord(args)
  const details: string[] = []

  if (method === 'createAction' && isBsv21IdentityMintArgs(method, args)) {
    const hints = bsv21IdentityMintHints(args)
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Mint a BSV-21 token'
    details.push('Backed by your HandCash identity (Sigma issuer)')
    if (hints.sym) details.push(`Token: ${hints.sym}`)
    if (hints.amt) details.push(`Supply: ${hints.amt}`)
    details.push('Not covered by Pay or Auto-pay')
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    let total = 0
    for (const raw of outputs) {
      if (!raw || typeof raw !== 'object') continue
      const sats = typeof (raw as { satoshis?: unknown }).satoshis === 'number'
        ? ((raw as { satoshis: number }).satoshis)
        : 0
      total += sats
    }
    return {
      title: 'Mint token',
      summary: description,
      amountSats: total > 0 ? total : undefined,
      amountLabel: total > 0 ? formatBsvSignificant(total, 5) : undefined,
      details,
    }
  }

  if (method === 'createAction' && isItemIssuanceArgs(method, args)) {
    const fungible = isBsv21SpendArgs(method, args)
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

  if (method === 'createAction' && isColourIssuanceArgs(method, args)) {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Mint a 1Sat token'
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    details.push(`Tips: ${outputs.length}`)
    details.push('Type: 1Sat')
    details.push('Not covered by Pay or Auto-pay')
    return {
      title: 'Mint token',
      summary: description,
      details,
    }
  }

  if (method === 'createAction' && isColourSpendArgs(method, args)) {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Send a 1Sat token'
    details.push('Type: 1Sat')
    details.push('Not covered by Pay or Auto-pay')
    return {
      title: 'Send token',
      summary: description,
      details,
      itemOutpoint: firstInputOutpoint(body),
      tokenId: tokenIdFromBody(body),
    }
  }

  if (method === 'createAction' && isBsv21SpendArgs(method, args)) {
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Send a token'
    if (Array.isArray(body.labels) && body.labels.includes('bsv21')) {
      details.push('Type: BSV-21')
    }
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

  if (method === 'signAction' && isColourSpendArgs(method, args)) {
    return {
      title: 'Confirm token send',
      summary: 'Finish signing a 1Sat token transfer',
      details: ['Not covered by Pay or Auto-pay'],
    }
  }

  if (method === 'signAction' && isBsv21SpendArgs(method, args)) {
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
    return {
      title: 'Confirm payment',
      summary: 'Finish signing a payment you already started',
      details: [],
    }
  }

  if (method === 'internalizeAction' && isBsv21ReceiveArgs(method, args)) {
    if (Array.isArray(body.labels) && body.labels.includes('bsv21')) {
      details.push('Type: BSV-21')
    }
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
      title: 'Accept funds',
      summary: 'Add incoming coins to your HandCash wallet',
      details: typeof body.description === 'string' ? [body.description] : [],
    }
  }

  if (method === 'relinquishOutput' && isColourSpendArgs(method, args)) {
    return {
      title: 'Remove token tip',
      summary: 'Drop a 1Sat token tip from basket storage',
      details: ['Does not broadcast a transaction'],
    }
  }

  if (method === 'relinquishOutput' && isBsv21SpendArgs(method, args)) {
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

  if (method === 'createMarketListingAdvert') {
    const price = Math.max(0, Math.trunc(Number(body.priceSats) || 0))
    const outpoint =
      typeof body.outpoint === 'string' ? body.outpoint : 'Unknown item'
    const isToken = body.assetType === 'bsv21'
    const label =
      (typeof body.sym === 'string' && body.sym.trim()) ||
      (typeof body.name === 'string' && body.name.trim()) ||
      (isToken ? 'token' : 'item')
    const units =
      isToken && Number.isSafeInteger(Number(body.listAmt))
        ? `${Number(body.listAmt).toLocaleString()} `
        : ''
    return {
      title: `List ${units}${label} for sale`,
      summary: isToken
        ? 'Create an on-chain BRC-48 offer for this BSV-21 token'
        : 'Create an on-chain BRC-48 offer for this collectable',
      amountSats: price || undefined,
      amountLabel: price ? formatBsvSignificant(price, 5) : undefined,
      itemOutpoint: normalizeItemOutpoint(body.outpoint) ?? undefined,
      tokenId: isToken
        ? (typeof body.origin === 'string' ? body.origin : undefined)
        : undefined,
      details: [
        price ? `Price ${price.toLocaleString()} sats` : 'Price unset',
      ],
    }
  }

  if (method === 'purchaseMarketListing') {
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
    return {
      title: 'Buy market item',
      summary: 'Authorize one atomic item purchase',
      amountSats: price || undefined,
      amountLabel: price ? formatBsvSignificant(price, 5) : undefined,
      details: [
        'Total includes the 5% market fee',
        'No payment is sent unless the exact item settlement can complete',
      ],
    }
  }

  if (method === 'createMarketPurchaseIntent') {
    const listing =
      body.listing && typeof body.listing === 'object'
        ? (body.listing as Record<string, unknown>)
        : {}
    const price = Math.max(0, Math.trunc(Number(listing.priceSats) || 0))
    return {
      title: 'Approve market purchase',
      summary: `Sign an intent to buy this item for ${price.toLocaleString()} sats`,
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
  if (isItemReceiveArgs(method, args) || isBsv21ReceiveArgs(method, args)) {
    patchItemAccess(origin, (cur) => ({ ...cur, canReceive: true }))
  }
}

export function requestActionApproval(
  origin: string | undefined,
  method: string,
  args: unknown,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const { title, summary, details, amountLabel, amountSats, itemOutpoint, tokenId } =
    summarizeAction(method, args)
  const itemSpend =
    isItemSpendArgs(method, args) ||
    isBsv21SpendArgs(method, args) ||
    isColourSpendArgs(method, args) ||
    isColourIssuanceArgs(method, args)
  const itemReceive = isItemReceiveArgs(method, args) || isBsv21ReceiveArgs(method, args)
  const identityMint = isBsv21IdentityMintArgs(method, args)

  // Item send / receive and identity-backed token mints are never covered by
  // Pay or Auto-pay. Send / mint always prompt; receive may reuse a prior grant.
  if (itemSpend || identityMint) {
    // fall through to prompt
  } else if (itemReceive) {
    const access = getItemAccess(key)
    if (access.canReceive) return Promise.resolve('allow')
  } else if (canAutoProcessPayment(key, method, amountSats)) {
    return Promise.resolve('allow')
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

  // Coalesce only methods where one displayed decision can safely stand for
  // another method-identical request. Signatures and market mutations bind
  // request-specific payloads and always receive their own prompt.
  if (
    !NO_COALESCE_ACTIONS.has(method) &&
    current?.request.kind === 'action' &&
    current.request.origin === key &&
    current.request.method === method
  ) {
    return new Promise((resolve) => {
      const prev = current!
      current = {
        request: prev.request,
        resolve: (decision) => {
          if (decision === 'allow' && isIdentityProofMethod(method)) {
            sessionApprovedProofs.add(proofGrantKey(key, method))
          }
          if (decision === 'allow' && (itemSpend || itemReceive)) {
            rememberItemActionGrant(key, method, args)
          }
          prev.resolve(decision)
          resolve(decision)
        },
      }
    })
  }

  const queued = queue.find(
    (item) =>
      !NO_COALESCE_ACTIONS.has(method) &&
      item.request.kind === 'action' &&
      item.request.origin === key &&
      item.request.method === method,
  )
  if (queued) {
    return new Promise((resolve) => {
      const prevResolve = queued.resolve
      queued.resolve = (decision) => {
        if (decision === 'allow' && isIdentityProofMethod(method)) {
          sessionApprovedProofs.add(proofGrantKey(key, method))
        }
        if (decision === 'allow' && (itemSpend || itemReceive)) {
          rememberItemActionGrant(key, method, args)
        }
        prevResolve(decision)
        resolve(decision)
      }
    })
  }

  return enqueuePrompt({
    id: idCounter++,
    kind: 'action',
    origin: key,
    method,
    title,
    summary,
    details,
    amountLabel,
    amountSats,
    itemOutpoint,
    tokenId,
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
  const active = getActiveWallet()
  if (!active) return []
  try {
    const listed = await active.wallet.listOutputs({
      basket,
      limit: 1000,
      includeTags: true,
      includeCustomInstructions: true,
      seekPermission: false,
    })
    return listed.outputs ?? []
  } catch {
    return []
  }
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
  if (!request.wantsAll && request.scope === 'id' && request.ids.length > 0) {
    return { request, tickers: request.ids }
  }
  const outputs = await listHeldOutputs('bsv21')
  const tokens = grantableTokensFromOutputs(outputs)
  return {
    request: {
      scope: 'id',
      ids: tokens.map((t) => t.id),
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
    details.push('All BSV-21 tokens')
  }
  for (const ticker of tickers.slice(0, 24)) details.push(`Token: ${ticker}`)
  if (tickers.length === 0) details.push('No BSV-21 tokens in this wallet')
  return {
    title: 'View tokens',
    summary: 'See BSV-21 tokens in this wallet',
    details,
  }
}

/**
 * Gate listOutputs against item baskets. Pay does not include inventory access.
 * Returns allow/deny; caller should filter results when grant is filtered.
 * Third parties never receive view='all'.
 */
export async function requestItemViewApproval(
  origin: string | undefined,
  args: unknown,
  preparedRequest?: ItemViewRequest,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const body = asRecord(args)
  if (!isItemBasket(body.basket)) return 'allow'

  let request = preparedRequest ?? parseItemViewRequest(args)
  const thirdParty = isThirdPartyOriginator(origin)
  let promptNames: string[] | undefined
  if (thirdParty && (request.wantsAll || request.scope === 'plain')) {
    const converted = await thirdPartyItemViewRequest(request)
    request = converted.request
    promptNames = converted.names
  }
  const access = getItemAccess(key)
  if (itemViewGranted(access, request)) return 'allow'
  // BRC-165 `id` is a narrow row lookup, not inventory access. Record only
  // this id-scoped grant so response filtering can enforce the same ceiling.
  if (request.scope === 'id' && !request.wantsAll) {
    patchItemAccess(key, (cur) => mergeItemViewGrant(cur, request, { allowAll: !thirdParty }))
    return 'allow'
  }

  const { title, summary, details } = promptNames
    ? summarizeFilteredItemView(promptNames)
    : summarizeItemView(request)

  const grant = (decision: PermissionDecision) => {
    if (decision === 'allow') {
      patchItemAccess(key, (cur) => mergeItemViewGrant(cur, request, { allowAll: !thirdParty }))
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

  let request = preparedRequest ?? parseTokenViewRequest(args)
  const thirdParty = isThirdPartyOriginator(origin)
  let tickers: string[] = request.ids
  if (thirdParty && (request.wantsAll || request.scope === 'plain')) {
    const converted = await thirdPartyTokenViewRequest(request)
    request = converted.request
    tickers = converted.tickers
  }
  const access = getTokenAccess(key)
  if (tokenViewGranted(access, request)) return 'allow'

  const { title, summary, details } = summarizeTokenView(tickers, request.wantsAll)

  const grant = (decision: PermissionDecision) => {
    if (decision === 'allow') {
      patchTokenAccess(key, (cur) => mergeTokenViewGrant(cur, request, { allowAll: !thirdParty }))
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
    if (thirdParty && isOnesatFtLeftoverRow(o)) return false
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
): Promise<'allow' | 'deny' | 'unauthenticated'> {
  if (isPublicMethod(method)) return 'allow'

  if (isSilentAuthMethod(method)) {
    return isOriginAllowed(origin) ? 'allow' : 'unauthenticated'
  }

  if (isOriginAllowed(origin)) return 'allow'

  const decision = await requestOriginPermission(origin, method)
  if (decision === 'allow') {
    allowOrigin(origin)
    return 'allow'
  }
  return isConnectMethod(method) ? 'unauthenticated' : 'deny'
}
