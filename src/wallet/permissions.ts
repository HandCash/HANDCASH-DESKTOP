import {
  appDisplayName,
  normalizeAppHost,
} from './appIdentity'
import { canAutoProcessPayment, clearAutoPaySettings } from './autoPay'
import { getMissingBackupStep, isBackupConfirmed } from './backupStatus'
import {
  DEFAULT_ITEM_ACCESS,
  isItemBasket,
  isItemReceiveArgs,
  isItemSpendArgs,
  itemViewGranted,
  mergeItemViewGrant,
  normalizeItemAccess,
  outputMatchesItemAccess,
  parseItemViewRequest,
  type ItemAccess,
  type ItemViewRequest,
} from './itemAccess'
import { openSetting } from './navStore'
import { formatBsvSignificant } from './session'
import { playWalletSound } from './soundService'
import { durableGetItem, durableSetItem } from './durableStorage.js'

/** Block connect / spend until keys + history backups are confirmed. */
function denyUntilBackupConfirmed(): Promise<PermissionDecision> {
  playWalletSound('deny')
  void window.handcash?.focusWindow?.()
  const missing = getMissingBackupStep()
  openSetting(missing === 'history' ? 'history-backup' : 'backup')
  return Promise.resolve('deny')
}

const STORAGE_KEY = 'handcash.brc100.connectedApps'

export type PermissionDecision = 'allow' | 'deny'

export type ConnectedApp = {
  origin: string
  name: string
  connectedAt: number
  /** Collectable / NFT capabilities — never implied by Pay. */
  itemAccess?: ItemAccess
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
  'encrypt',
  'decrypt',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'proveCertificate',
  'acquireCertificate',
])

let idCounter = 1
let listener: PromptListener | null = null
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
  listener?.(current?.request ?? null)
}

function pumpQueue(): void {
  if (current || queue.length === 0) {
    notify()
    return
  }
  current = queue.shift() ?? null
  notify()
  void window.handcash?.focusWindow?.()
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
  return method === 'createSignature' || method === 'proveCertificate'
}

const FRESH_CONNECT_MS = 20_000
const recentlyConnectedAt = new Map<string, number>()
const sessionApprovedProofs = new Set<string>()

function proofGrantKey(origin: string, method: string): string {
  return `${origin}::${method}`
}

function markRecentlyConnected(origin: string): void {
  recentlyConnectedAt.set(origin, Date.now())
}

function wasRecentlyConnected(origin: string): boolean {
  const at = recentlyConnectedAt.get(origin)
  return at != null && Date.now() - at < FRESH_CONNECT_MS
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

export function revokeOrigin(origin: string): void {
  const key = normalizeOrigin(origin)
  writeConnected(readConnected().filter((a) => a.origin !== key))
  clearAutoPaySettings(key)
  clearPermissionSession(key)
}

export function revokeAllOrigins(): void {
  writeConnected([])
  clearAutoPaySettings()
  clearPermissionSession()
}

export function subscribePermissionRequests(cb: PromptListener): () => void {
  listener = cb
  cb(current?.request ?? null)
  return () => {
    if (listener === cb) listener = null
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

export function resolvePermission(id: number, decision: PermissionDecision): void {
  if (!current || current.request.id !== id) return
  const { resolve } = current
  current = null
  resolve(decision)
  pumpQueue()
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
  notify()
}

export function requestOriginPermission(origin: string | undefined, method: string): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)

  if (!isBackupConfirmed()) return denyUntilBackupConfirmed()

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

export function summarizeAction(method: string, args: unknown): {
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
} {
  const body = asRecord(args)
  const details: string[] = []

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
    return {
      title: 'Sign with wallet',
      summary: 'Create a signature proving you control this wallet',
      details: [],
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
  if (isItemSpendArgs(method, args)) {
    patchItemAccess(origin, (cur) => ({ ...cur, canSend: true }))
    return
  }
  if (isItemReceiveArgs(method, args)) {
    patchItemAccess(origin, (cur) => ({ ...cur, canReceive: true }))
  }
}

export function requestActionApproval(
  origin: string | undefined,
  method: string,
  args: unknown,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const { title, summary, details, amountLabel, amountSats } = summarizeAction(method, args)
  const itemSpend = isItemSpendArgs(method, args)
  const itemReceive = isItemReceiveArgs(method, args)

  if (
    (method === 'createAction' || method === 'signAction') &&
    !isBackupConfirmed()
  ) {
    return denyUntilBackupConfirmed()
  }

  // Item send / receive are never covered by Pay or Auto-pay.
  // Send always prompts (each transfer). Receive may reuse a prior grant.
  if (itemSpend) {
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

  // Coalesce concurrent identical action prompts (apps often fire createSignature twice).
  if (
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
  for (const c of request.creators) details.push(`Creator: ${c}`)
  return {
    title: 'View items',
    summary: 'See specific collectables in this wallet',
    details,
  }
}

/**
 * Gate listOutputs against item baskets. Pay does not include inventory access.
 * Returns allow/deny; caller should filter results when grant is filtered.
 */
export async function requestItemViewApproval(
  origin: string | undefined,
  args: unknown,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const body = asRecord(args)
  if (!isItemBasket(body.basket)) return 'allow'

  if (!isBackupConfirmed()) return denyUntilBackupConfirmed()

  const request = parseItemViewRequest(args)
  const access = getItemAccess(key)
  if (itemViewGranted(access, request)) return 'allow'

  const { title, summary, details } = summarizeItemView(request)

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
          if (decision === 'allow') {
            patchItemAccess(key, (cur) => mergeItemViewGrant(cur, request))
          }
          prev.resolve(decision)
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
  }).then((decision) => {
    if (decision === 'allow') {
      patchItemAccess(key, (cur) => mergeItemViewGrant(cur, request))
    }
    return decision
  })
}

/** Filter listOutputs payload to what the app's item grant allows. */
export function filterItemOutputsForOrigin(
  origin: string | undefined,
  result: unknown,
): unknown {
  const access = getItemAccess(origin)
  if (access.view === 'all' || access.view === 'none') return result
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[]; totalOutputs?: number }
  if (!Array.isArray(body.outputs)) return result
  const outputs = body.outputs.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const o = raw as { tags?: string[]; customInstructions?: string }
    return outputMatchesItemAccess(access, o.tags, o.customInstructions)
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
