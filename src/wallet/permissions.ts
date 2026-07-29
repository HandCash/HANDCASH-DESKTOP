import {
  appDisplayName,
  normalizeAppHost,
} from './appIdentity'
import { canAutoProcessPayment, clearAutoPaySettings } from './autoPay'
import { formatBsv } from './session'

const STORAGE_KEY = 'handcash.brc100.connectedApps'

export type PermissionDecision = 'allow' | 'deny'

export type ConnectedApp = {
  origin: string
  name: string
  connectedAt: number
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
  // Prefer new key; fall back to legacy allowlist key.
  const next = localStorage.getItem(STORAGE_KEY)
  if (next) return migrateRaw(next)
  const legacy = localStorage.getItem('handcash.brc100.allowedOrigins')
  if (legacy) {
    const apps = migrateRaw(legacy)
    writeConnected(apps)
    localStorage.removeItem('handcash.brc100.allowedOrigins')
    return apps
  }
  return []
}

function emitConnected(): void {
  const apps = readConnected()
  for (const cb of connectedListeners) cb(apps)
}

function writeConnected(apps: ConnectedApp[]): void {
  const dedup = new Map<string, ConnectedApp>()
  for (const app of apps) {
    dedup.set(app.origin, app)
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([...dedup.values()].sort((a, b) => b.connectedAt - a.connectedAt)),
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
  const existing = readConnected().filter((a) => a.origin !== key)
  writeConnected([
    {
      origin: key,
      name: appDisplayName(key),
      connectedAt: Date.now(),
    },
    ...existing,
  ])
}

export function revokeOrigin(origin: string): void {
  const key = normalizeOrigin(origin)
  writeConnected(readConnected().filter((a) => a.origin !== key))
  clearAutoPaySettings(key)
}

export function revokeAllOrigins(): void {
  writeConnected([])
  clearAutoPaySettings()
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
  cb(readConnected())
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

export function summarizeAction(method: string, args: unknown): {
  title: string
  summary: string
  details: string[]
  amountLabel?: string
  amountSats?: number
} {
  const body = asRecord(args)
  const details: string[] = []

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
      if (sats > 0) details.push(`${label}: ${formatBsv(sats)}`)
    }
    return {
      title: 'Approve payment',
      summary: description,
      amountSats: total > 0 ? total : undefined,
      amountLabel: total > 0 ? formatBsv(total) : undefined,
      details,
    }
  }

  if (method === 'signAction') {
    return {
      title: 'Confirm payment',
      summary: 'Finish signing a payment you already started',
      details: [],
    }
  }

  if (method === 'internalizeAction') {
    return {
      title: 'Accept funds',
      summary: 'Add incoming coins to your HandCash wallet',
      details: typeof body.description === 'string' ? [body.description] : [],
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

export function requestActionApproval(
  origin: string | undefined,
  method: string,
  args: unknown,
): Promise<PermissionDecision> {
  const key = normalizeOrigin(origin)
  const { title, summary, details, amountLabel, amountSats } = summarizeAction(method, args)

  if (canAutoProcessPayment(key, method, amountSats)) {
    return Promise.resolve('allow')
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
  })
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
