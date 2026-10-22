/**
 * One call that issues a BRC-169 handle certificate for an app or the wallet's
 * own UI (`issueHandle` on the BRC-100 bridge).
 *
 * The caller names the handle, the identity key that should own it and the
 * HandCash claim ticket it holds. The wallet refuses a key it is not signing
 * with, asks the user, and records the approval as a grant scoped to that app,
 * handle and key: single use, expiring `HANDLE_ISSUE_GRANT_TTL_MS` after the
 * user approves, and revocable until it is used. Only then does the existing
 * claim run (`claimCloudHandlePayload`): BRC-CLOUD checks and spends the
 * ticket, binds the handle and signs the certificate. The ticket is passed
 * through, never shown in the prompt, stored or logged; the HMAC secret that
 * mints tickets never reaches this wallet.
 */
import { HOME_HANDLE_DOMAIN } from './handleDomain'
import { normalizeHandleName } from './handleFormat'
import type { ClaimedHandleCertificate } from './handleClaim'

export const HANDLE_ISSUE_GRANT_TTL_MS = 120_000

const HANDLE_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/
const IDENTITY_KEY_PATTERN = /^0[23][0-9a-f]{64}$/
const TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const TICKET_MAX_LENGTH = 2048

export type HandleIssueRequest = {
  handle: string
  /** The owner: an identity key this wallet signs with, not necessarily a fixed account. */
  identityKey: string
  claimTicket: string
}

/** What the prompt and the grant name. The ticket is not part of it. */
export type HandleIssueScope = Pick<HandleIssueRequest, 'handle' | 'identityKey'>

export type HandleIssueGrant = HandleIssueScope & {
  id: number
  origin: string
  grantedAt: number
  expiresAt: number
}

export type HandleIssueResult = {
  handle: string
  domain: string
  display: string
  identityKey: string
  certificate: ClaimedHandleCertificate
}

export type HandleIssueErrorCode =
  | 'HANDLE_ISSUE_INVALID'
  | 'HANDLE_ISSUE_WRONG_KEY'
  | 'HANDLE_ISSUE_REFUSED'
  | 'HANDLE_ISSUE_GRANT_EXPIRED'
  | 'HANDLE_ISSUE_GRANT_USED'
  | 'HANDLE_ISSUE_GRANT_REVOKED'
  | 'HANDLE_ISSUE_TICKET_REJECTED'
  | 'HANDLE_ISSUE_TAKEN'
  | 'HANDLE_ISSUE_FAILED'

const ERROR_STATUS: Record<HandleIssueErrorCode, number> = {
  HANDLE_ISSUE_INVALID: 400,
  HANDLE_ISSUE_WRONG_KEY: 403,
  HANDLE_ISSUE_REFUSED: 403,
  HANDLE_ISSUE_GRANT_EXPIRED: 403,
  HANDLE_ISSUE_GRANT_USED: 409,
  HANDLE_ISSUE_GRANT_REVOKED: 403,
  HANDLE_ISSUE_TICKET_REJECTED: 400,
  HANDLE_ISSUE_TAKEN: 409,
  HANDLE_ISSUE_FAILED: 502,
}

export class HandleIssueError extends Error {
  readonly code: HandleIssueErrorCode
  readonly status: number
  /** BRC-CLOUD's own code, when it refused the claim. */
  readonly reason?: string

  constructor(code: HandleIssueErrorCode, message: string, reason?: string) {
    super(message)
    this.name = 'HandleIssueError'
    this.code = code
    this.status = ERROR_STATUS[code]
    if (reason) this.reason = reason
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

export function parseHandleIssueScope(raw: unknown): HandleIssueScope {
  const body = asRecord(raw)
  const handle = typeof body.handle === 'string' ? normalizeHandleName(body.handle) : ''
  if (!HANDLE_PATTERN.test(handle)) throw new HandleIssueError('HANDLE_ISSUE_INVALID', 'Name a valid handle to issue.')
  const identityKey = typeof body.identityKey === 'string' ? body.identityKey.trim().toLowerCase() : ''
  if (!IDENTITY_KEY_PATTERN.test(identityKey)) {
    throw new HandleIssueError('HANDLE_ISSUE_INVALID', 'Name the identity key that should own the handle, as a compressed public key.')
  }
  return { handle, identityKey }
}

export function parseHandleIssueRequest(raw: unknown): HandleIssueRequest {
  const scope = parseHandleIssueScope(raw)
  const ticket = asRecord(raw).claimTicket
  const claimTicket = typeof ticket === 'string' ? ticket.trim() : ''
  if (!claimTicket || claimTicket.length > TICKET_MAX_LENGTH || !TICKET_PATTERN.test(claimTicket)) {
    throw new HandleIssueError('HANDLE_ISSUE_INVALID', 'Pass the HandCash claim ticket for this handle and key.')
  }
  return { ...scope, claimTicket }
}

type GrantRecord = HandleIssueGrant & { state: 'live' | 'used' | 'revoked' }

let grantIds = 1
const grants = new Map<number, GrantRecord>()
const grantListeners = new Set<(grants: HandleIssueGrant[]) => void>()

function publicGrant({ state: _state, ...grant }: GrantRecord): HandleIssueGrant {
  return grant
}

function pruneGrants(now: number): void {
  for (const [id, g] of grants) if (g.state !== 'live' || g.expiresAt <= now) grants.delete(id)
}

function notifyGrants(): void {
  const live = listHandleIssueGrants()
  for (const fn of grantListeners) {
    try {
      fn(live)
    } catch {
      // ignore listener errors
    }
  }
}

/** Records the user's approval. Only `issueHandleCertificate` grants; exported for tests. */
export function grantHandleIssue(origin: string, scope: HandleIssueScope, now: number): HandleIssueGrant {
  pruneGrants(now)
  const grant: GrantRecord = {
    id: grantIds++,
    origin,
    handle: scope.handle,
    identityKey: scope.identityKey,
    grantedAt: now,
    expiresAt: now + HANDLE_ISSUE_GRANT_TTL_MS,
    state: 'live',
  }
  grants.set(grant.id, grant)
  notifyGrants()
  return publicGrant(grant)
}

/**
 * Spends a grant for exactly the app, handle and key it was given for. A used,
 * revoked or expired grant, or one for another scope, never authorizes a claim.
 */
export function takeHandleIssueGrant(id: number, origin: string, scope: HandleIssueScope, now: number): void {
  const grant = grants.get(id)
  if (!grant || grant.state === 'used') {
    throw new HandleIssueError('HANDLE_ISSUE_GRANT_USED', 'This approval was already used. Ask again to issue another handle.')
  }
  if (grant.state === 'revoked') {
    throw new HandleIssueError('HANDLE_ISSUE_GRANT_REVOKED', 'You revoked this approval before the handle was issued.')
  }
  if (grant.origin !== origin || grant.handle !== scope.handle || grant.identityKey !== scope.identityKey) {
    throw new HandleIssueError('HANDLE_ISSUE_REFUSED', 'This approval was given for a different app, handle or key.')
  }
  if (grant.expiresAt <= now) {
    grants.delete(id)
    notifyGrants()
    throw new HandleIssueError('HANDLE_ISSUE_GRANT_EXPIRED', 'The approval expired before the handle was issued. Ask again.')
  }
  grant.state = 'used'
  notifyGrants()
}

/** Approvals not yet used, newest last. */
export function listHandleIssueGrants(now = Date.now()): HandleIssueGrant[] {
  return [...grants.values()].filter((g) => g.state === 'live' && g.expiresAt > now).map(publicGrant)
}

export function subscribeHandleIssueGrants(listener: (grants: HandleIssueGrant[]) => void): () => void {
  grantListeners.add(listener)
  return () => {
    grantListeners.delete(listener)
  }
}

export function revokeHandleIssueGrant(id: number): boolean {
  const grant = grants.get(id)
  if (!grant || grant.state !== 'live') return false
  grant.state = 'revoked'
  notifyGrants()
  return true
}

/** Revokes every unused approval, or only one app's. */
export function revokeHandleIssueGrants(origin?: string): void {
  let changed = false
  for (const grant of grants.values()) {
    if (grant.state === 'live' && (origin === undefined || grant.origin === origin)) {
      grant.state = 'revoked'
      changed = true
    }
  }
  if (changed) notifyGrants()
}

export type HandleIssueDeps = {
  now: () => number
  /** The identity key the wallet signs with now, or null when locked. */
  activeIdentityKey: () => string | null
  /** Shows the prompt. Gets the scope only: the ticket is never shown. */
  approve: (origin: string, scope: HandleIssueScope) => Promise<'allow' | 'deny'>
  /** Loads the claim path and returns the call that spends the ticket. */
  prepare: () => Promise<(request: HandleIssueRequest) => Promise<HandleIssueResult>>
}

const TICKET_REFUSALS = new Set([
  'claim-ticket-required',
  'malformed-ticket',
  'invalid-ticket',
  'ticket-expired',
  'ticket-handle-mismatch',
  'ticket-identity-mismatch',
  'ticket-used',
])

function claimFailure(err: unknown): HandleIssueError {
  if (err instanceof HandleIssueError) return err
  const reason = (err as { code?: unknown } | null)?.code
  if (typeof reason === 'string') {
    if (TICKET_REFUSALS.has(reason)) {
      return new HandleIssueError('HANDLE_ISSUE_TICKET_REJECTED', `HandCash refused the claim ticket (${reason}). Get a new ticket for this handle and key.`, reason)
    }
    if (reason === 'handle-taken') return new HandleIssueError('HANDLE_ISSUE_TAKEN', 'Another identity key already holds this handle.', reason)
    if (reason === 'wrong-identity') return new HandleIssueError('HANDLE_ISSUE_WRONG_KEY', 'The claim was not signed by the key it names.', reason)
  }
  // The host may have bound the handle and spent the ticket before the reply was lost.
  return new HandleIssueError(
    'HANDLE_ISSUE_FAILED',
    `The handle may or may not have been issued: ${err instanceof Error ? err.message : String(err)}. Resolve the handle before trying again.`,
    typeof reason === 'string' ? reason : undefined,
  )
}

function assertSigningKey(deps: HandleIssueDeps, identityKey: string): void {
  if (deps.activeIdentityKey()?.toLowerCase() !== identityKey) {
    throw new HandleIssueError(
      'HANDLE_ISSUE_WRONG_KEY',
      'HandCash is not signing with that identity key. Switch to the account that owns it, then ask again.',
    )
  }
}

export async function issueHandleCertificate(origin: string, raw: unknown, deps: HandleIssueDeps): Promise<HandleIssueResult> {
  const request = parseHandleIssueRequest(raw)
  const scope: HandleIssueScope = { handle: request.handle, identityKey: request.identityKey }
  assertSigningKey(deps, scope.identityKey)

  if ((await deps.approve(origin, scope)) !== 'allow') {
    throw new HandleIssueError('HANDLE_ISSUE_REFUSED', 'You refused to issue this handle.')
  }
  const grant = grantHandleIssue(origin, scope, deps.now())

  let send: Awaited<ReturnType<HandleIssueDeps['prepare']>>
  try {
    send = await deps.prepare()
  } catch (err) {
    revokeHandleIssueGrant(grant.id)
    throw claimFailure(err)
  }
  // The account may have changed while the prompt was open.
  assertSigningKey(deps, scope.identityKey)
  takeHandleIssueGrant(grant.id, origin, scope, deps.now())

  let result: HandleIssueResult
  try {
    result = await send(request)
  } catch (err) {
    throw claimFailure(err)
  }
  if (result.handle !== scope.handle || result.identityKey.toLowerCase() !== scope.identityKey) {
    throw new HandleIssueError('HANDLE_ISSUE_FAILED', 'Another handle claim answered instead of this one. Resolve the handle before trying again.')
  }
  return result
}

/** The wallet's own wiring: the active account, the action prompt and the existing claim. */
export function walletHandleIssueDeps(activeIdentityKey: () => string | null, bridgeRequestId?: number): HandleIssueDeps {
  return {
    now: Date.now,
    activeIdentityKey,
    approve: async (origin, scope) => {
      const { requestActionApproval } = await import('./permissions')
      return requestActionApproval(origin, 'issueHandle', scope, undefined, bridgeRequestId)
    },
    prepare: async () => {
      const { claimCloudHandlePayload } = await import('./handleClaim')
      return async (request) => {
        const claimed = await claimCloudHandlePayload({ handle: request.handle, claimTicket: request.claimTicket })
        if (!claimed.certificate) {
          throw new HandleIssueError('HANDLE_ISSUE_FAILED', 'HandCash bound the handle but returned no certificate. Resolve the handle to fetch it.')
        }
        return {
          handle: claimed.handle,
          domain: HOME_HANDLE_DOMAIN,
          display: claimed.display,
          identityKey: claimed.identityKey,
          certificate: claimed.certificate,
        }
      }
    },
  }
}
