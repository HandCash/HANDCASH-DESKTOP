/** Scanned sign-in codes on the approving device, as Activity rows. */
import { recordAddedDevice, type AddedDevice } from '../addedDevices'
import { getLegacyGoogleEnrollment } from '../legacyGoogleRecovery'
import { confirmPresence } from '../deviceSignin/approver'
import type { SigninRowFace, SigninRowView } from '../deviceSignin/view'
import { localDeviceLabel, vaultTransferOf, type VaultTransfer } from '../deviceTransfer'
import { requireWalletRuntime } from '../walletRuntime'
import {
  helloScanLogin,
  refuseScanLogin,
  ScanLoginUnreachable,
  sendScanLoginVault,
  type ScanLoginConnection,
} from './approver'
import type { ScanLoginPayload } from './payload'

type Entry = {
  payload: ScanLoginPayload
  face: SigninRowFace
  conn: ScanLoginConnection | null
  error: string | null
  createdAt: number
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
  vault: () => vaultTransferOf(requireWalletRuntime().instance.vaultMaster, getLegacyGoogleEnrollment()),
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
  entries.set(key, { payload, face: 'claimed', conn: null, error: null, createdAt: Date.now() })
  changed()
  try {
    const conn = await helloScanLogin(payload, { label: deps.label(), fetchImpl: deps.fetchImpl })
    update(key, { conn, face: 'comparing' })
  } catch (error) {
    if (error instanceof ScanLoginUnreachable) update(key, { face: 'unreachable' })
    else update(key, { face: 'refused', error: error instanceof Error ? error.message : String(error) })
  }
}

const approving = new Set<string>()

export async function approveScanLogin(loginKey: string): Promise<void> {
  const entry = entries.get(loginKey)
  if (entry && entry.payload.expiresAt <= Date.now()) throw new Error('This sign-in expired. Scan a fresh code.')
  if (!entry?.conn || entry.face !== 'comparing') throw new Error('Compare the codes before approving')
  if (approving.has(loginKey)) throw new Error('Already sending to this device')
  approving.add(loginKey)
  try {
    await deps.confirm(`approve sign-in on ${entry.payload.label}`)
    await sendScanLoginVault(entry.conn, deps.vault(), deps.fetchImpl)
    update(loginKey, { face: 'approved' })
    deps.onApproved({ id: loginKey, label: entry.payload.label, via: 'local' })
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
  }
  const requested = `Sign-in requested on ${label}`
  switch (entry.face) {
    case 'comparing':
      return { ...base, title: requested, detail: 'Compare the code, then approve', code: entry.conn?.code ?? null, live: true }
    case 'approved':
      return { ...base, title: `Signed in on ${label}`, detail: 'Approved here, sent over your local network', live: false }
    case 'unreachable':
      return {
        ...base,
        title: `Couldn't reach ${label}`,
        detail: `Not on this network. On ${label}, choose Sign in with email`,
        live: false,
      }
    case 'refused':
      return { ...base, title: 'Sign-in refused', detail: entry.error ?? label, live: false }
    case 'expired':
      return { ...base, title: 'Sign-in expired', detail: `${label} · nobody approved it`, live: false }
    default:
      return { ...base, title: requested, detail: `Connecting to ${label} on this network`, live: true }
  }
}

export function listScanLoginRows(): SigninRowView[] {
  return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt).map((entry) => scanLoginRowView(entry))
}
