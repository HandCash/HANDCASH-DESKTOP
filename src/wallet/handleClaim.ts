/**
 * BRC-169 cloud handle claim — separate from balance migration.
 *
 * Write methods (`claimCloudHandle`, `clearClaimedCloudHandle`) stay on the
 * HandCash migration allowlist. Read (`getClaimedCloudHandle`) is available to
 * any authenticated BRC-100 app — Free Radio and others hold an identity key
 * and need the bound handle without a second username field.
 *
 * On claim we keep the registry certificate locally and, when it looks like a
 * real BRC-52 direct issuance, also `acquireCertificate` so `listCertificates`
 * can answer the silent standards path.
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { getActiveWallet } from './session'
import { claimHandle, resolveHandle } from './handleResolve'
import { formatHandCashHandle, normalizeHandleName } from './handleFormat'
import { isMigrationOrigin } from './migration'

const STORAGE_KEY = 'handcash.brc169.claimedHandle.v1'

/** BRC-169 §4.5 handle-certificate type. */
export const BRC169_HANDLE_CERT_TYPE =
  'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8='

export type ClaimedHandleCertificate = {
  type?: string
  subject?: string
  certifier?: string
  serialNumber?: string | null
  fields?: Record<string, string>
  revocationOutpoint?: string | null
  signature?: string
  [key: string]: unknown
}

export type ClaimedHandleState = {
  handle: string
  display: string
  identityKey: string
  claimedAt: number
  /** Registry attestation — present after a successful claim / re-verify. */
  certificate?: ClaimedHandleCertificate | null
}

export function isHandleClaimWriteMethod(method: string): boolean {
  return method === 'claimCloudHandle' || method === 'clearClaimedCloudHandle'
}

export function isHandleClaimReadMethod(method: string): boolean {
  return method === 'getClaimedCloudHandle'
}

export function isHandleClaimMethod(method: string): boolean {
  return isHandleClaimWriteMethod(method) || isHandleClaimReadMethod(method)
}

/** Origins allowed to mint / clear a claim (HandCash web hosts only). */
export function isHandleClaimOrigin(origin: string | undefined): boolean {
  return isMigrationOrigin(origin)
}

function normalizeCloudHandle(raw: string): string {
  const h = normalizeHandleName(raw)
  if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(h)) {
    throw new Error('Invalid handle')
  }
  return h
}

function asCertificate(raw: unknown): ClaimedHandleCertificate | null {
  if (!raw || typeof raw !== 'object') return null
  return raw as ClaimedHandleCertificate
}

/**
 * A real BRC-52 direct acquisition needs a hex signature + serial + outpoint.
 * BRC-CLOUD still issues `_dev` placeholders in lab; those stay in durable
 * storage for getClaimedCloudHandle but are not stuffed into listCertificates.
 */
function isAcquirableCertificate(cert: ClaimedHandleCertificate): boolean {
  if (cert._dev === true) return false
  const sig = typeof cert.signature === 'string' ? cert.signature.trim() : ''
  const serial =
    typeof cert.serialNumber === 'string' ? cert.serialNumber.trim() : ''
  const certifier =
    typeof cert.certifier === 'string' ? cert.certifier.trim() : ''
  const type = typeof cert.type === 'string' ? cert.type.trim() : ''
  const revocation =
    typeof cert.revocationOutpoint === 'string'
      ? cert.revocationOutpoint.trim()
      : ''
  return (
    type.length > 0 &&
    certifier.length > 0 &&
    serial.length > 0 &&
    revocation.length > 0 &&
    /^[0-9a-fA-F]+$/.test(sig) &&
    sig.length >= 64
  )
}

async function tryAcquireHandleCertificate(
  cert: ClaimedHandleCertificate,
): Promise<boolean> {
  if (!isAcquirableCertificate(cert)) return false
  const active = getActiveWallet()
  if (!active?.wallet?.acquireCertificate) return false
  try {
    const fields = cert.fields ?? {}
    await active.wallet.acquireCertificate({
      type: String(cert.type || BRC169_HANDLE_CERT_TYPE),
      certifier: String(cert.certifier),
      acquisitionProtocol: 'direct',
      fields: {
        handle: String(fields.handle || ''),
        domain: String(fields.domain || ''),
      },
      serialNumber: String(cert.serialNumber),
      revocationOutpoint: String(cert.revocationOutpoint),
      signature: String(cert.signature),
    })
    return true
  } catch (err) {
    console.warn(
      '[handle-claim] acquireCertificate skipped',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

export function readClaimedCloudHandle(): ClaimedHandleState | null {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ClaimedHandleState>
    if (
      typeof parsed.handle !== 'string' ||
      typeof parsed.display !== 'string' ||
      typeof parsed.identityKey !== 'string' ||
      typeof parsed.claimedAt !== 'number'
    ) {
      return null
    }
    return {
      handle: parsed.handle,
      // Upgrade legacy `$…` / `@$…@domain` cache rows to `@handle@domain`.
      display: /^@[a-z0-9]/.test(parsed.display) && !parsed.display.startsWith('@$')
        ? parsed.display
        : formatHandCashHandle(parsed.handle, 'handcash.io', { fullyQualified: true }),
      identityKey: parsed.identityKey.toLowerCase(),
      claimedAt: parsed.claimedAt,
      certificate: asCertificate(parsed.certificate),
    }
  } catch {
    return null
  }
}

/** Claim for this wallet’s identity key, if any. */
export function claimedHandleForIdentity(
  identityKey: string | null | undefined,
): ClaimedHandleState | null {
  const claimed = readClaimedCloudHandle()
  if (!claimed || !identityKey) return null
  return claimed.identityKey === identityKey.trim().toLowerCase() ? claimed : null
}

const claimListeners = new Set<() => void>()

function notifyClaimListeners(): void {
  for (const fn of claimListeners) {
    try {
      fn()
    } catch {
      // ignore listener errors
    }
  }
}

/** Re-read when a claim lands (same session / after bridge mint). */
export function subscribeClaimedCloudHandle(listener: () => void): () => void {
  claimListeners.add(listener)
  return () => {
    claimListeners.delete(listener)
  }
}

export function getClaimedCloudHandlePayload(): ClaimedHandleState | null {
  return readClaimedCloudHandle()
}

/** Drop local claim cache (does not revoke on BRC-CLOUD). */
export function clearClaimedCloudHandlePayload(): { cleared: true } {
  durableRemoveItem(STORAGE_KEY)
  notifyClaimListeners()
  return { cleared: true }
}

function persistClaim(state: ClaimedHandleState): void {
  durableSetItem(STORAGE_KEY, JSON.stringify(state))
  notifyClaimListeners()
}

/**
 * Return the local claim only if BRC-CLOUD still binds it to this identity.
 * Stale cache after an ops clear used to block reclaim and break $handle send.
 * Refreshes the stored certificate from the live resolve response.
 */
export async function getClaimedCloudHandleVerified(): Promise<ClaimedHandleState | null> {
  const local = readClaimedCloudHandle()
  if (!local) return null
  try {
    const resolved = await resolveHandle(`$${local.handle}`)
    if (resolved.identityKey.toLowerCase() !== local.identityKey.toLowerCase()) {
      clearClaimedCloudHandlePayload()
      return null
    }
    const certificate = asCertificate(resolved.certificate) ?? local.certificate ?? null
    const next: ClaimedHandleState = {
      ...local,
      display: resolved.display || local.display,
      certificate,
    }
    if (JSON.stringify(next) !== JSON.stringify(local)) {
      persistClaim(next)
      if (certificate) void tryAcquireHandleCertificate(certificate)
    }
    return next
  } catch {
    clearClaimedCloudHandlePayload()
    return null
  }
}

let claimInFlight: Promise<ClaimedHandleState> | null = null

export async function claimCloudHandlePayload(args: {
  handle: string
  claimTicket?: string
}): Promise<ClaimedHandleState> {
  if (claimInFlight) return claimInFlight
  claimInFlight = (async () => {
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')

    const handle = normalizeCloudHandle(args.handle)
    const claimTicket =
      typeof args.claimTicket === 'string' ? args.claimTicket.trim() : ''
    if (!claimTicket) {
      throw new Error(
        'Handle claim requires a HandCash claim ticket. Open /claim-handle while signed in.',
      )
    }

    const result = await claimHandle({
      handle,
      identityKey: active.identityKey,
      claimTicket,
    })

    const certificate = asCertificate(result.certificate)
    const state: ClaimedHandleState = {
      handle,
      display: result.display,
      identityKey: active.identityKey.toLowerCase(),
      claimedAt: Date.now(),
      certificate,
    }
    persistClaim(state)
    if (certificate) await tryAcquireHandleCertificate(certificate)
    return state
  })().finally(() => {
    claimInFlight = null
  })
  return claimInFlight
}
