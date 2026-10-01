import type { WalletRuntime } from './walletRuntime'
import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
const state = vi.hoisted(() => ({
  active: null as ActiveWallet | null,
  values: new Map<string, string>(),
  writable: true,
}))
vi.mock('./walletRuntime', () => ({
  runtimeIsCurrent: (runtime: WalletRuntime) =>
    runtime.instance === state.active,
}))
function runtime(): WalletRuntime {
  return { instance: state.active } as WalletRuntime
}
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.values.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (!state.writable) return false
    state.values.set(key, value)
    return true
  },
}))
import {
  exportPublicIdentityBackup,
  importIssuerPrivateKey,
  importPublicIdentityProfile,
  issuanceSigner,
  listPublicIdentities,
  removePublicIdentity,
  restorePublicIdentityBackup,
  saveWalletPublicIdentity,
  selectedPublicIdentityKey,
  selectPublicIdentity,
} from './publicIdentities'
import { signPublicIdentityProfile } from './publicIdentityProfile'
const root = PrivateKey.fromHex('01'.padStart(64, '0'))
const imported = PrivateKey.fromHex('02'.padStart(64, '0'))
const fields = {
  displayName: 'Issuer',
  icon: 'https://example.test/icon.png',
  description: '',
}
function active(key = root, chain: 'main' | 'test' = 'main'): ActiveWallet {
  return {
    identityKey: key.toPublicKey().toString(),
    rootKeyHex: key.toHex().padStart(64, '0'),
    chain,
    accountIndex: 0,
  } as ActiveWallet
}
beforeEach(() => {
  state.values.clear()
  state.writable = true
  state.active = active()
})
describe('issuer custody', () => {
  it('encrypts imported keys, preserves the exact issuer, and keeps exports public', () => {
    const id = importIssuerPrivateKey(runtime(), imported.toWif(), fields)
    expect(id).toBe(imported.toPublicKey().toString())
    const file = exportPublicIdentityBackup(runtime())
    expect(file).not.toContain(imported.toHex().padStart(64, '0'))
    expect(file).not.toContain(imported.toWif())
    expect(listPublicIdentities(runtime())[0]).not.toHaveProperty('sealedKey')
    selectPublicIdentity(runtime(), id)
    expect(issuanceSigner(runtime()).rootKeyHex).toBe(
      imported.toHex().padStart(64, '0'),
    )
    expect(() =>
      issuanceSigner(runtime(), root.toPublicKey().toString()),
    ).toThrow(/changed after approval/)
  })
  it('keeps records account/network scoped and refuses a different wallet backup', () => {
    saveWalletPublicIdentity(runtime(), fields)
    const backup = JSON.parse(exportPublicIdentityBackup(runtime()))
    state.active = active(imported)
    expect(listPublicIdentities(runtime())).toEqual([])
    expect(() => restorePublicIdentityBackup(runtime(), backup)).toThrow()
    state.active = active(root, 'test')
    expect(listPublicIdentities(runtime())).toEqual([])
    expect(() => restorePublicIdentityBackup(runtime(), backup)).toThrow()
  })
  it('public profiles never grant signing authority; deleting a selected signer resets to wallet', () => {
    const profile = signPublicIdentityProfile(imported.toHex(), 'main', fields)
    importPublicIdentityProfile(runtime(), profile)
    expect(() => selectPublicIdentity(runtime(), profile.identityKey)).toThrow(
      /does not control/,
    )
    importIssuerPrivateKey(
      runtime(),
      imported.toHex().padStart(64, '0'),
      fields,
    )
    selectPublicIdentity(runtime(), profile.identityKey)
    removePublicIdentity(runtime(), profile.identityKey)
    expect(selectedPublicIdentityKey(runtime())).toBe(
      root.toPublicKey().toString(),
    )
  })
  it('restores signer custody without overwriting a newer public profile', () => {
    const id = importIssuerPrivateKey(
      runtime(),
      imported.toHex().padStart(64, '0'),
      fields,
    )
    const backup = JSON.parse(exportPublicIdentityBackup(runtime()))
    removePublicIdentity(runtime(), id)
    const newer = signPublicIdentityProfile(imported.toHex(), 'main', {
      ...fields,
      displayName: 'Updated issuer',
    })
    importPublicIdentityProfile(runtime(), newer)
    restorePublicIdentityBackup(runtime(), backup)
    expect(listPublicIdentities(runtime())[0]?.profile.displayName).toBe(
      'Updated issuer',
    )
    selectPublicIdentity(runtime(), id)
    expect(issuanceSigner(runtime()).identityKey).toBe(id)
    const corrupted = structuredClone(backup)
    corrupted.identities[0].sealedKey = 'AAAA'
    expect(() => restorePublicIdentityBackup(runtime(), corrupted)).toThrow()
  })
  it('rejects failed persistence and invalid scalars instead of reporting an import', () => {
    for (const value of ['00'.repeat(32), 'ff'.repeat(32), 'API_TOKEN'])
      expect(() => importIssuerPrivateKey(runtime(), value, fields)).toThrow()
    state.writable = false
    expect(() => saveWalletPublicIdentity(runtime(), fields)).toThrow(
      /Could not save/,
    )
    expect(listPublicIdentities(runtime())).toEqual([])
    state.active = null
    expect(() => listPublicIdentities(null)).toThrow(/Unlock/)
  })
})
