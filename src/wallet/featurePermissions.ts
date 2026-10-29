import { toastError } from './toast'
import { hasFeatureDeclarationHint } from './featureManifest'
import { WalletPermissionsManager, type GroupedPermissions, type PermissionRequest, type PermissionToken } from '@handcash/wallet-engine'
import type { EcpmAuthorizationRequest } from '@bsv/ecpm-permission-module'
import { getWalletRuntime, registerWalletRuntimeLifecycle, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { requestFeatureApproval, type PermissionLifetime } from './permissions'
import { runExclusiveSpend } from './spendGuard'
import { parseActionLabelPermission } from './actionLabelPermission'

type Entry = { manager: WalletPermissionsManager; abort: AbortController; unregister: () => void }
const entries = new Map<string, Entry>()
function assertCurrent(runtime: WalletRuntime) { if (!runtimeIsCurrent(runtime)) throw new Error('Wallet permission session changed') }
function safeProtocol(protocol: unknown): boolean {
  if (!Array.isArray(protocol) || ![1, 2].includes(protocol[0]) || typeof protocol[1] !== 'string') return false
  const name = protocol[1].toLowerCase().trim()
  return name !== '3241645161d8' && !name.startsWith('admin') && (!name.startsWith('p ') || name.startsWith('p ecpm '))
}
function describe(request: PermissionRequest): string {
  const label = request.actionLabel ?? (request.protocolID ? parseActionLabelPermission(request.protocolID[0], request.protocolID[1]) : null)
  if (label) return label.operation === 'apply' ? `Add “${label.label}” to new transactions.` : label.operation === 'list' ? `Read all wallet history labeled “${label.label}”, including matching activity from other apps.` : `Apply “${label.label}” and read all matching wallet history (legacy grant).`
  if (request.protocolID?.[1].startsWith('p ecpm ')) return `Mask and unmask data for ${request.protocolID[1].slice(7)}. Covers all points and key IDs in this feature.`
  return `Use protocol keys for ${request.protocolID?.[1]}. Covers this protocol’s key IDs and cryptographic operations.`
}
async function grant(runtime: WalletRuntime, lifetime: PermissionLifetime, work: () => Promise<void>) {
  assertCurrent(runtime)
  try {
    if (lifetime === 'remember') await runExclusiveSpend(async () => { assertCurrent(runtime); await work() })
    else await work()
  } catch (error) {
    if (lifetime === 'remember' && runtimeIsCurrent(runtime)) toastError('Permission saving could not be confirmed', 'The current operation or part of a group may already be allowed. Review Wallet feature access and the app before retrying.')
    throw error
  }
  assertCurrent(runtime)
}
export function clearFeaturePermissions(): void {
  for (const entry of entries.values()) { entry.abort.abort(); entry.manager.revokeSessionPermissions(); entry.unregister() }
  entries.clear()
}
function managerFor(runtime: WalletRuntime): WalletPermissionsManager {
  assertCurrent(runtime)
  const existing = entries.get(runtime.runtimeId)
  if (existing) return existing.manager
  const abort = new AbortController()
  const manager = new WalletPermissionsManager(runtime.instance.wallet, 'handcash.wallet', { preferAppPermissionGroups: true, differentiateActionLabelOperations: true, seekGroupedPermission: true })
  const settle = (request: PermissionRequest & { requestID: string }) => {
    void (async () => {
      const lifetime = await requestFeatureApproval({ origin: request.originator, capabilities: [describe(request)], details: [
        `Protocol: ${JSON.stringify(request.protocolID)}; security level: ${request.protocolID?.[0]}; counterparty: ${request.counterparty || 'self'}`,
        ...(request.moduleDetails ? [`Operation: ${request.moduleDetails.operation}; point: ${request.moduleDetails.point}; key ID: ${request.moduleDetails.keyID}`] : [])
      ], grouped: false }, abort.signal)
      assertCurrent(runtime)
      if (lifetime === null) { await manager.denyPermission(request.requestID); return }
      await grant(runtime, lifetime, () => manager.grantPermission({ requestID: request.requestID, ...(lifetime === 'once' ? { ephemeral: true } : lifetime === 'session' ? { sessionDurationMs: 1_800_000 } : {}) }))
    })().catch(() => { void manager.denyPermission(request.requestID).catch(() => {}) })
  }
  manager.bindCallback('onProtocolPermissionRequested', settle)
  manager.bindCallback('onGroupedPermissionRequested', (request: { originator: string; requestID: string; permissions: GroupedPermissions }) => {
    void (async () => {
      const granted: GroupedPermissions = { protocolPermissions: (request.permissions.protocolPermissions ?? []).filter(item => safeProtocol(item.protocolID)) }
      if (!granted.protocolPermissions?.length) { await manager.denyGroupedPermission(request.requestID); return }
      const lifetime = await requestFeatureApproval({ origin: request.originator, grouped: true,
        capabilities: granted.protocolPermissions.map(item => `${describe({ type: 'protocol', originator: request.originator, protocolID: item.protocolID, counterparty: item.counterparty })} App purpose: ${item.description}`),
        details: granted.protocolPermissions.map(item => `${JSON.stringify(item.protocolID)}; counterparty: ${item.counterparty || 'self'}`)
      }, abort.signal)
      assertCurrent(runtime)
      if (lifetime === null) { await manager.denyGroupedPermission(request.requestID); return }
      await grant(runtime, lifetime, () => manager.grantGroupedPermission({ requestID: request.requestID, granted, ...(lifetime === 'remember' ? {} : { sessionDurationMs: 1_800_000 }) }))
    })().catch(() => { void manager.denyGroupedPermission(request.requestID).catch(() => {}) })
  })
  const unregister = registerWalletRuntimeLifecycle({ name: `feature-permissions:${runtime.runtimeId}`, dispose: disposed => {
    if (disposed.runtimeId !== runtime.runtimeId) return
    abort.abort(); manager.revokeSessionPermissions(); entries.delete(runtime.runtimeId); unregister()
  } })
  entries.set(runtime.runtimeId, { manager, abort, unregister })
  return manager
}
export async function authorizeEcpmFeature(runtime: WalletRuntime, request: EcpmAuthorizationRequest): Promise<boolean> {
  if (request.privileged) return false
  const allowed = await managerFor(runtime).ensureProtocolPermission({ originator: request.originator, privileged: false,
    protocolID: [request.securityLevel, `p ecpm ${request.logicalProtocolID}`], counterparty: request.counterparty, usageType: 'generic', seekPermission: request.seekPermission,
    moduleDetails: { scheme: 'ecpm', operation: request.operation, point: request.point, keyID: request.keyID }
  })
  assertCurrent(runtime)
  return allowed
}
/** Only explicitly declared, non-financial features may replace per-payload approval. */
export async function authorizeDeclaredFeature(runtime: WalletRuntime, method: string, args: unknown, originator: string): Promise<boolean> {
  if (!['getPublicKey', 'createSignature', 'encrypt', 'decrypt', 'createHmac', 'verifyHmac', 'verifySignature'].includes(method) || !args || typeof args !== 'object') return false
  const body = args as { protocolID?: [0 | 1 | 2, string]; counterparty?: string; privileged?: boolean; identityKey?: boolean; seekPermission?: boolean }
  if (body.privileged || body.identityKey || !safeProtocol(body.protocolID)) return false
  const protocolID = body.protocolID!, counterparty = body.counterparty ?? 'self'
  const existing = entries.get(runtime.runtimeId)?.manager
  if (existing && await existing.hasProtocolPermission({ originator, privileged: false, protocolID, counterparty })) return true
  if (!hasFeatureDeclarationHint(originator, protocolID, counterparty)) return false
  const manager = managerFor(runtime)
  if (!await manager.hasDeclaredProtocolPermission({ originator, protocolID, counterparty })) return false
  await manager.ensureProtocolPermission({ originator, privileged: false, protocolID, counterparty, usageType: 'generic', seekPermission: body.seekPermission })
  assertCurrent(runtime)
  return true
}
export async function authorizeActionLabels(runtime: WalletRuntime, method: string, args: unknown, originator: string): Promise<void> {
  if (!['listActions', 'createAction', 'internalizeAction'].includes(method) || !args || typeof args !== 'object') return
  const labels = (args as { labels?: unknown }).labels
  if (!Array.isArray(labels)) return
  for (const label of labels) {
    if (typeof label !== 'string') continue
    await managerFor(runtime).ensureLabelAccess({ originator, label, usageType: method === 'listActions' ? 'list' : 'apply' })
    assertCurrent(runtime)
  }
}
export type FeatureAccess = { id: string; origin: string; title: string; description: string; expiresAt?: number; token?: PermissionToken }
export async function listFeatureAccess(): Promise<FeatureAccess[]> {
  const runtime = getWalletRuntime()
  if (!runtime) return []
  const manager = managerFor(runtime)
  const sessions = manager.listSessionPermissions().map((grant, i) => ({ id: `session:${i}:${grant.request.originator}`, origin: grant.request.originator, title: 'Session access', description: describe(grant.request), expiresAt: grant.expiresAt }))
  const tokens = await manager.listProtocolPermissions()
  assertCurrent(runtime)
  return [...sessions, ...tokens.map(token => ({ id: `${token.txid}.${token.outputIndex}`, origin: token.originator,
    title: 'Remembered access', description: describe({ type: 'protocol', originator: token.originator, protocolID: [token.securityLevel ?? 1, token.protocol ?? ''], counterparty: token.counterparty }), token, expiresAt: token.expiry ? token.expiry * 1000 : undefined }))]
}
export async function revokeFeatureAccess(access: FeatureAccess): Promise<void> {
  const runtime = getWalletRuntime()
  if (!runtime) throw new Error('Wallet locked')
  const manager = managerFor(runtime)
  manager.revokeSessionPermissions(access.origin)
  if (access.token) await runExclusiveSpend(async () => { assertCurrent(runtime); await manager.revokePermission(access.token!); assertCurrent(runtime) })
}
