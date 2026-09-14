/**
 * Local catalog of Sigma personas this wallet has published.
 * Chain is the authority: an unspent control output means active. This cache
 * is how the identity screen remembers names and outpoints between launches.
 */

import { durableGetItem, durableSetItem } from '../durableStorage'
import { sigmaIdentityBasket } from './paths'

const STORAGE_KEY = 'handcash.sigmaIdentity.v1'

export type SigmaPersonaStatus = 'funding' | 'active' | 'revoked'

export type SigmaPersonaRecord = {
  id: string
  name: string
  about?: string
  generation: number
  publicKey: string
  address: string
  identityKey: string
  basket: string
  status: SigmaPersonaStatus
  createdAt: number
  origin?: string
  controlOutpoint?: string
  fundOutpoint?: string
}

type Store = {
  signingId?: string
  byWallet: Record<string, SigmaPersonaRecord[]>
}

const listeners = new Set<() => void>()

function emptyStore(): Store {
  return { byWallet: {} }
}

function readStore(): Store {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Store
    if (!parsed || typeof parsed !== 'object' || !parsed.byWallet) return emptyStore()
    return parsed
  } catch {
    return emptyStore()
  }
}

function writeStore(store: Store): void {
  durableSetItem(STORAGE_KEY, JSON.stringify(store))
  for (const listener of listeners) listener()
}

function walletKey(identityKey: string): string {
  return identityKey.trim().toLowerCase()
}

export function subscribeSigmaIdentities(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function listSigmaIdentities(identityKey: string): SigmaPersonaRecord[] {
  const rows = readStore().byWallet[walletKey(identityKey)] ?? []
  return rows.map((row) => ({ ...row }))
}

export function signingSigmaIdentity(identityKey: string): SigmaPersonaRecord | null {
  const store = readStore()
  const rows = store.byWallet[walletKey(identityKey)] ?? []
  const active = rows.filter((row) => row.status === 'active')
  if (store.signingId) {
    const chosen = active.find((row) => row.id === store.signingId)
    if (chosen) return { ...chosen }
  }
  return active[0] ? { ...active[0] } : null
}

export function selectSigningSigmaIdentity(identityKey: string, personaId: string): void {
  const store = readStore()
  const rows = store.byWallet[walletKey(identityKey)] ?? []
  if (!rows.some((row) => row.id === personaId && row.status === 'active')) return
  store.signingId = personaId
  writeStore(store)
}

export function rememberSigmaIdentity(record: SigmaPersonaRecord): void {
  const store = readStore()
  const key = walletKey(record.identityKey)
  const rows = store.byWallet[key] ?? []
  const next = rows.filter((row) => row.id !== record.id)
  next.unshift(record)
  store.byWallet[key] = next
  if (!store.signingId && record.status === 'active') store.signingId = record.id
  writeStore(store)
}

export function patchSigmaIdentity(
  identityKey: string,
  personaId: string,
  patch: Partial<SigmaPersonaRecord>,
): SigmaPersonaRecord | null {
  const store = readStore()
  const key = walletKey(identityKey)
  const rows = store.byWallet[key] ?? []
  const idx = rows.findIndex((row) => row.id === personaId)
  if (idx < 0) return null
  const next = { ...rows[idx]!, ...patch, id: personaId, identityKey }
  if (patch.basket == null) next.basket = next.basket || sigmaIdentityBasket(personaId)
  rows[idx] = next
  store.byWallet[key] = rows
  if (next.status === 'revoked' && store.signingId === personaId) {
    store.signingId = rows.find((row) => row.status === 'active')?.id
  }
  writeStore(store)
  return { ...next }
}
