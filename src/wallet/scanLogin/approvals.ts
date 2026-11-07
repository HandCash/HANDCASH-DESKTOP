/** Scanned sign-in codes on the approving device, as Activity rows. */
import { recordAddedDevice, type AddedDevice } from '../addedDevices'
import { getEmailRecoveryEnrollment } from '../brc250/store'
import { confirmPresence } from '../deviceSignin/approver'
import type { SigninRowFace, SigninRowView } from '../deviceSignin/view'
import { localDeviceLabel, vaultTransferOf, type VaultTransfer } from '../deviceTransfer'
import { requireWalletRuntime } from '../walletRuntime'
import {
  confirmPairingCode,
  helloScanLogin,
  PairingCodeRejected,
  refuseScanLogin,
  ScanLoginUnreachable,
  sendScanLoginVault,
  type ScanLoginConnection,
} from './approver'
import { PAIRING_CODE_LENGTH, PAIRING_MAX_ATTEMPTS, type ScanLoginPayload } from './payload'

type Entry = {
  payload: ScanLoginPayload
  face: SigninRowFace
  conn: ScanLoginConnection | null
  error: string | null
  createdAt: number
  /** The new device accepted the digits a person typed. Nothing is sent before this. */
  confirmed: boolean
  attemptsLeft: number
}

export type ScanLoginDeps = {
  fetchImpl?: typeof fetch
  label?: () => string
  vault?: () => VaultTransfer
  confirm?: (reason: string) => Promise<void>
  onApproved?: (device: Omit<AddedDevice, 'addedAt'>) => void
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let deps: Required<ScanLoginDeps> = {
  fetchImpl: (...args) => fetch(...args),
  label: () => localDeviceLabel(),
  vault: () => vaultTransferOf(requireWalletRuntime().instance.vaultMaster, getEmailRecoveryEnrollment()),
  confirm: confirmPresence,
  onApproved: (device) => recordAddedDevice(device),
}

/** Test seam. */
export function setScanLoginDeps(next: ScanLoginDeps): void {
  deps = { ...deps, ...next }
  entries.clear()
}

function changed(): void {
  for (const listener of listeners) listener()
}

function update(key: string, patch: Partial<Entry>): void {
  const entry = entries.get(key)
  if (!entry) return
  entries.set(key, { ...entry, ...patch })
  changed()
}

export function subscribeScanLogins(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A scanned code: reach the new device right away, then wait on the user's approval. */
export async function startScanLoginApproval(payload: ScanLoginPayload): Promise<void> {
  const key = payload.loginKey
  entries.set(key, { payload, face: 'claimed', conn: null, error: null, createdAt: Date.now(), confirmed: false, attemptsLeft: PAIRING_MAX_ATTEMPTS })
  changed()
  console.info('[scan-login] scanned', JSON.stringify({ label: payload.label, urls: payload.urls, expiresAt: payload.expiresAt }))
  try {
    const conn = await helloScanLogin(payload, { label: deps.label(), fetchImpl: deps.fetchImpl })
    console.info('[scan-login] reached', conn.url)
    update(key, { conn, face: 'comparing' })
  } catch (error) {
    console.warn('[scan-login] not connected', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    if (error instanceof ScanLoginUnreachable) update(key, { face: 'unreachable' })
    else update(key, { face: 'refused', error: error instanceof Error ? error.message : String(error) })
  }
}

const approving = new Set<string>()
const confirming = new Set<string>()

function rejectionText(error: PairingCodeRejected, label: string): string {
  switch (error.reason) {
    case 'wrong':
      return `That code doesn't match ${label}. ${error.attemptsLeft} ${error.attemptsLeft === 1 ? 'try' : 'tries'} left.`
    case 'locked':
      return `Too many wrong codes. Show a fresh code on ${label}.`
    case 'expired':
      return `The code on ${label} ran out. Show a fresh one.`
    default:
      return `${label} ended this sign-in. Show a fresh code there.`
  }
}

/**
 * Check the digits a person typed from the new device's screen. The code is never
 * known here: the new device decides, counts wrong tries and ends the session.
 */
export type PairingOutcome =
  | { ok: true }
  /** Not accepted. `ended`: the new device closed the session, so typing again cannot help. */
  | { ok: false; ended: boolean; attemptsLeft: number; message: string }

export async function confirmScanLoginCode(loginKey: string, typed: string): Promise<PairingOutcome> {
  const entry = entries.get(loginKey)
  if (entry && entry.payload.expiresAt <= Date.now()) throw new Error('This sign-in expired. Scan a fresh code.')
  if (!entry?.conn || entry.face !== 'comparing') throw new Error('This sign-in is not waiting for a code')
  if (entry.confirmed) return { ok: true }
  if (!new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`).test(typed)) throw new Error(`Type all ${PAIRING_CODE_LENGTH} numbers`)
  if (confirming.has(loginKey)) throw new Error('Already checking this code')
  confirming.add(loginKey)
  try {
    await confirmPairingCode(entry.conn, typed, deps.fetchImpl)
    update(loginKey, { confirmed: true })
    return { ok: true }
  } catch (error) {
    if (error instanceof PairingCodeRejected) {
      const text = rejectionText(error, entry.payload.label)
      const ended = error.reason !== 'wrong' && error.reason !== 'replayed'
      if (ended) update(loginKey, { face: 'refused', error: text })
      else update(loginKey, { attemptsLeft: error.attemptsLeft })
      return { ok: false, ended, attemptsLeft: error.attemptsLeft, message: text }
    }
    throw error
  } finally {
    confirming.delete(loginKey)
  }
}

export async function approveScanLogin(loginKey: string): Promise<void> {
  const entry = entries.get(loginKey)
  if (entry && entry.payload.expiresAt <= Date.now()) throw new Error('This sign-in expired. Scan a fresh code.')
  if (!entry?.conn || entry.face !== 'comparing' || !entry.confirmed) throw new Error('Type the code shown on the new device first')
  if (approving.has(loginKey)) throw new Error('Already sending to this device')
  approving.add(loginKey)
  try {
    await deps.confirm(`approve sign-in on ${entry.payload.label}`)
    if (entries.get(loginKey) !== entry || entry.face !== 'comparing' || entry.payload.expiresAt <= Date.now()) {
      throw new Error('This sign-in ended. Scan a fresh code.')
    }
    await sendScanLoginVault(entry.conn, deps.vault(), deps.fetchImpl)
    console.info('[scan-login] setup verified')
    update(loginKey, { face: 'approved' })
    deps.onApproved({ id: loginKey, label: entry.payload.label, via: 'local' })
  } catch (error) {
    console.warn('[scan-login] approve failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    throw error
  } finally {
    approving.delete(loginKey)
  }
}

export async function refuseScanLoginFor(loginKey: string): Promise<void> {
  const entry = entries.get(loginKey)
  if (!entry) return
  if (entry.conn) await refuseScanLogin(entry.conn, deps.fetchImpl).catch(() => undefined)
  update(loginKey, { face: 'refused', error: null })
}

export function scanLoginRowView(entry: Entry, now = Date.now()): SigninRowView {
  const { payload } = entry
  const label = payload.label
  const live = entry.face === 'claimed' || entry.face === 'comparing'
  if (live && payload.expiresAt <= now) entry = { ...entry, face: 'expired' }
  const base = {
    key: `scan:${payload.loginKey}`,
    binding: payload.loginKey,
    via: 'local' as const,
    face: entry.face,
    label,
    location: '',
    createdAt: entry.createdAt,
    expiresAt: payload.expiresAt,
    code: null as string | null,
    pairing: null as SigninRowView['pairing'],
  }
  const requested = `Sign-in requested on ${label}`
  switch (entry.face) {
    case 'comparing':
      return {
        ...base,
        title: requested,
        detail: `Type the code shown on ${label}`,
        pairing: { length: PAIRING_CODE_LENGTH, attemptsLeft: entry.attemptsLeft, confirmed: entry.confirmed },
        live: true,
      }
    case 'approved':
      return { ...base, title: `Signed in on ${label}`, detail: 'Wallet installed and opened there. This does not mean the devices stay connected.', live: false }
    case 'unreachable':
      return {
        ...base,
        title: `Couldn't reach ${label}`,
        detail: `${label} didn't answer. Show a fresh code there`,
        live: false,
      }
    case 'refused':
      return { ...base, title: 'Sign-in refused', detail: entry.error ?? label, live: false }
    case 'expired':
      return { ...base, title: 'Sign-in expired', detail: `${label} · nobody approved it`, live: false }
    default:
      return { ...base, title: requested, detail: `Connecting to ${label}`, live: true }
  }
}

export function listScanLoginRows(): SigninRowView[] {
  return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt).map((entry) => scanLoginRowView(entry))
}
