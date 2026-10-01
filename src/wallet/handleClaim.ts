import { getActiveWallet } from './session'
import { storageRegistry } from '../storage/registry'

/**
 * BRC-169 cloud handle claim — separate from balance migration.
 *
 * Write methods (`claimCloudHandle`, `clearClaimedCloudHandle`) stay on the
 * HandCash migration allowlist. Read (`getClaimedCloudHandle`) is available to
 * any authenticated BRC-100 app — Free Radio and others hold an identity key
 * and need the bound handle without a second username field.
 *
 * On claim we keep the verified public certificate locally and
 * `acquireCertificate` the subject-encrypted copy (BRC-169 §4.6), so
 * `listCertificates` / `proveCertificate` answer the standards path.
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { accountLocalKey } from './accountLocalKeys'

import { claimHandle, HandleNotFoundError, resolveHandle } from './handleResolve'
import { BRC169_HANDLE_CERT_TYPE, HANDLE_CERTIFIERS } from './handleCertificate'
import { formatHandCashHandle, normalizeHandleName } from './handleFormat'
import { isMigrationOrigin } from './migration'

const STORAGE_KEY = storageRegistry.claimedHandle.key
const HANDLE_DOMAIN = 'handcash.io'

export { BRC169_HANDLE_CERT_TYPE }

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

type WalletHandleCertificate = {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
  keyringForSubject: Record<string, string>
}

function stringRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string> = {}
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== 'string') return null
    out[k] = value
  }
  return out
}

/** The subject-encrypted copy, only when it names this wallet and the pinned certifier. */
function asWalletHandleCertificate(
  raw: unknown,
  identityKey: string,
): WalletHandleCertificate | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const fields = stringRecord(row.fields)
  const keyringForSubject = stringRecord(row.keyringForSubject)
  const text = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : '')
  if (
    !fields ||
    !keyringForSubject ||
    text('type') !== BRC169_HANDLE_CERT_TYPE ||
    text('certifier').toLowerCase() !== HANDLE_CERTIFIERS[HANDLE_DOMAIN] ||
    text('subject').toLowerCase() !== identityKey.toLowerCase() ||
    !text('serialNumber') ||
    !text('revocationOutpoint') ||
    !text('signature')
  ) {
    return null
  }
  return {
    type: text('type'),
    serialNumber: text('serialNumber'),
    subject: text('subject').toLowerCase(),
    certifier: text('certifier').toLowerCase(),
    revocationOutpoint: text('revocationOutpoint'),
    fields,
    signature: text('signature'),
    keyringForSubject,
  }
}

const heldSerials = new Set<string>()

/**
 * Holds exactly the current handle certificate in wallet storage: acquires it
 * when missing and relinquishes any other serial from the handle certifier.
 * `null` relinquishes them all (the binding ended).
 */
async function syncHeldHandleCertificate(current: WalletHandleCertificate | null): Promise<void> {
  if (current && heldSerials.has(current.serialNumber)) return
  const wallet = getActiveWallet()?.wallet
  if (!wallet?.listCertificates) return
  const certifier = HANDLE_CERTIFIERS[HANDLE_DOMAIN]!
  try {
    const { certificates } = await wallet.listCertificates({
      certifiers: [certifier],
      types: [BRC169_HANDLE_CERT_TYPE],
      limit: 50,
    })
    let held = false
    for (const cert of certificates) {
      if (current && cert.serialNumber === current.serialNumber) {
        held = true
        continue
      }
      await wallet.relinquishCertificate({
        type: BRC169_HANDLE_CERT_TYPE,
        serialNumber: cert.serialNumber,
        certifier,
      })
    }
    if (current && !held) {
      await wallet.acquireCertificate({
        type: current.type,
        certifier: current.certifier,
        acquisitionProtocol: 'direct',
        fields: current.fields,
        serialNumber: current.serialNumber,
        revocationOutpoint: current.revocationOutpoint,
        signature: current.signature,
        keyringRevealer: 'certifier',
        keyringForSubject: current.keyringForSubject,
      })
    }
    if (current) heldSerials.add(current.serialNumber)
  } catch (err) {
    console.warn(
      '[handle-claim] certificate sync skipped',
      err instanceof Error ? err.message : String(err),
    )
  }
}

export function readClaimedCloudHandle(): ClaimedHandleState | null {
  try {
    const raw = durableGetItem(accountLocalKey(STORAGE_KEY))
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
  durableRemoveItem(accountLocalKey(STORAGE_KEY))
  heldSerials.clear()
  void syncHeldHandleCertificate(null)
  notifyClaimListeners()
  return { cleared: true }
}

function persistClaim(state: ClaimedHandleState): void {
  durableSetItem(accountLocalKey(STORAGE_KEY), JSON.stringify(state))
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
    const next: ClaimedHandleState = {
      ...local,
      display: resolved.display || local.display,
      certificate: resolved.certificate,
    }
    if (JSON.stringify(next) !== JSON.stringify(local)) persistClaim(next)
    const walletCertificate = asWalletHandleCertificate(resolved.walletCertificate, local.identityKey)
    if (walletCertificate) void syncHeldHandleCertificate(walletCertificate)
    return next
  } catch (error) {
    // Only an answered "no such handle" ends the claim; an offline or failing
    // host says nothing about the binding.
    if (error instanceof HandleNotFoundError) {
      clearClaimedCloudHandlePayload()
      return null
    }
    return local
  }
}

let claimInFlight: Promise<ClaimedHandleState> | null = null
let claimBindingGeneration = 0

/** Do not share a pending claim promise across active vault accounts. */
export function rebindHandleClaimForAccount(): void {
  claimBindingGeneration += 1
  claimInFlight = null
  heldSerials.clear()
  notifyClaimListeners()
}

export async function claimCloudHandlePayload(args: {
  handle: string
  claimTicket?: string
}): Promise<ClaimedHandleState> {
  if (claimInFlight) return claimInFlight
  const bindingGeneration = claimBindingGeneration
  const pending = (async () => {
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

    const state: ClaimedHandleState = {
      handle,
      display: result.display,
      identityKey: active.identityKey.toLowerCase(),
      claimedAt: Date.now(),
      certificate: result.certificate,
    }
    if (bindingGeneration !== claimBindingGeneration) {
      throw new Error('Active wallet account changed during handle claim')
    }
    persistClaim(state)
    const walletCertificate = asWalletHandleCertificate(result.walletCertificate, state.identityKey)
    if (walletCertificate) await syncHeldHandleCertificate(walletCertificate)
    return state
  })()
  claimInFlight = pending
  try {
    return await pending
  } finally {
    if (claimInFlight === pending) claimInFlight = null
  }
}
