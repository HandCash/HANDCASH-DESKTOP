import type { WalletRuntime } from './walletRuntime'
import { EncryptedMessage, PrivateKey, Utils } from '@bsv/sdk'
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
  durableRemoveItem: (key: string) => {
    state.values.delete(key)
  },
}))
import {
  accountProfile,
  displayIssuerProfile,
  exportPublicIdentityBackup,
  importIssuerPrivateKey,
  issuanceSigner,
  listPublicIdentities,
  presentedIdentityMaterial,
  presentedPublicIdentityKey,
  presentPublicIdentity,
  recordPublishedIdentity,
  removePublicIdentity,
  restorePublicIdentityBackup,
  saveIdentityProfile,
  saveIssuerIdentityBackup,
  selectedPublicIdentityKey,
  selectPublicIdentity,
  setSignsIssuance,
  signsIssuance,
} from './publicIdentities'
import { bapIdentityFixture, beefOf, recordTx, rotationTx } from './issuerIdentity.fixture'
import { bapIdFor, bapIdScript, bapKey, BAP_REVOKED_ADDRESS } from './bapRecords'
import { buildIssuerIdentityPackage, issuerIdentityPackageBeef } from './issuerIdentity'
import { resetIssuerIdentitiesForTests } from './issuerIdentities'
import { identityProfileFor, resetIdentityProfilesForTests } from './identityProfiles'
import { parseIdentityKeyPackage, profileFromPackage } from './identityProfile'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
const root = PrivateKey.fromHex('01'.padStart(64, '0'))
const imported = PrivateKey.fromHex('02'.padStart(64, '0'))
const rootId = root.toPublicKey().toString()
const importedId = imported.toPublicKey().toString()
const pub = (key: PrivateKey) => key.toPublicKey().toString()
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
  resetIssuerIdentitiesForTests()
  resetIdentityProfilesForTests()
})
describe('issuer custody', () => {
  it('always lists the wallet signer, encrypts imported keys and keeps exports free of secrets', () => {
    expect(listPublicIdentities(runtime())).toEqual([
      { identityKey: rootId, signer: 'wallet', bapId: bapIdFor(root), profile: null, identity: null },
    ])
    const id = importIssuerPrivateKey(runtime(), imported.toWif())
    expect(id).toBe(importedId)
    const file = exportPublicIdentityBackup(runtime())
    expect(file).not.toContain(imported.toHex().padStart(64, '0'))
    expect(file).not.toContain(imported.toWif())
    expect(listPublicIdentities(runtime()).find((row) => row.identityKey === id)).not.toHaveProperty('sealedKey')
    selectPublicIdentity(runtime(), id)
    expect(issuanceSigner(runtime()).rootKeyHex).toBe(imported.toHex().padStart(64, '0'))
    expect(() => issuanceSigner(runtime(), rootId)).toThrow(/changed after approval/)
  })
  it('saves the issuer backup through the desktop save that reads it back', async () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    const save = vi.fn(async (_args: { filename: string; bytes: Uint8Array }) => ({
      ok: true as const,
      saved: true as const,
      path: '/backups/handcash-issuer-backup.json',
      bytes: 1,
    }))
    vi.stubGlobal('window', { handcash: { saveBackupFile: save } })
    try {
      const outcome = await saveIssuerIdentityBackup(runtime())
      expect(outcome).toEqual({ saved: true, path: '/backups/handcash-issuer-backup.json' })
      expect(save).toHaveBeenCalledTimes(1)
      const { filename, bytes } = save.mock.calls[0]![0]
      expect(filename).toBe('handcash-issuer-backup.json')
      expect(new TextDecoder().decode(bytes)).toBe(exportPublicIdentityBackup(runtime()))
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('keeps records account/network scoped and refuses a different wallet backup', async () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    const backup = JSON.parse(exportPublicIdentityBackup(runtime()))
    state.active = active(imported)
    expect(listPublicIdentities(runtime())).toHaveLength(1)
    await expect(restorePublicIdentityBackup(runtime(), backup)).rejects.toThrow()
    state.active = active(root, 'test')
    expect(listPublicIdentities(runtime())).toHaveLength(1)
    await expect(restorePublicIdentityBackup(runtime(), backup)).rejects.toThrow()
  })
  it('only controlled keys can be selected; removing a selected signer resets to the wallet', () => {
    expect(() => selectPublicIdentity(runtime(), importedId)).toThrow(/does not control/)
    importIssuerPrivateKey(runtime(), imported.toHex().padStart(64, '0'))
    selectPublicIdentity(runtime(), importedId)
    removePublicIdentity(runtime(), importedId)
    expect(selectedPublicIdentityKey(runtime())).toBe(rootId)
    expect(() => removePublicIdentity(runtime(), rootId)).toThrow(/cannot be removed/)
  })
  it('rejects failed persistence and invalid scalars instead of reporting an import', () => {
    for (const value of ['00'.repeat(32), 'ff'.repeat(32), 'API_TOKEN'])
      expect(() => importIssuerPrivateKey(runtime(), value)).toThrow()
    state.writable = false
    expect(() => importIssuerPrivateKey(runtime(), imported.toWif())).toThrow(/Could not save/)
    state.active = null
    expect(() => listPublicIdentities(null)).toThrow(/Unlock/)
  })
})
describe('published identity', () => {
  it('issues with the identity key; a published profile only names it', () => {
    expect(issuanceSigner(runtime())).toMatchObject({ identity: null, identityKey: rootId, priorKeys: [] })
    const f = bapIdentityFixture({ master: root, name: 'Wallet studio' })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    expect(issuanceSigner(runtime())).toEqual({
      identityKey: rootId,
      rootKeyHex: root.toHex().padStart(64, '0'),
      identity: expect.objectContaining({ bapId: f.bapId, name: 'Wallet studio' }),
      priorKeys: [pub(f.signer)],
    })
    expect(listPublicIdentities(runtime())[0]).toMatchObject({ published: f.bapId, bapId: f.bapId })
    expect(displayIssuerProfile(runtime(), { issuer: pub(f.signer), bapId: f.bapId })?.name).toBe('Wallet studio')
    expect(displayIssuerProfile(runtime(), { issuer: rootId })).toMatchObject({ id: f.bapId, source: 'bap' })
    expect(displayIssuerProfile(runtime(), { issuer: importedId, bapId: f.bapId })).toBeNull()
    expect(() => recordPublishedIdentity(runtime(), rootId, bapIdentityFixture({ master: imported }).pkg)).toThrow(
      /another key/,
    )
    expect(() => recordPublishedIdentity(runtime(), importedId, bapIdentityFixture({ master: imported }).pkg)).toThrow(
      /does not control/,
    )
  })
  it('after a rotation, still signs with the identity key and accepts every BAP key for its own earlier tokens', () => {
    const f = bapIdentityFixture({ master: root, aliasHeight: 900_010 })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    const { tx, next } = rotationTx(f, 1, { minedHeight: 900_020 })
    recordPublishedIdentity(
      runtime(),
      rootId,
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)], { preferAlias: tx.id('hex') })!,
    )
    expect(issuanceSigner(runtime())).toMatchObject({
      identityKey: rootId,
      identity: { bapId: f.bapId },
      priorKeys: [pub(f.signer), pub(next)],
    })
  })
  it('a revoked identity cannot issue', () => {
    const f = bapIdentityFixture({ master: root })
    const revoke = recordTx([bapIdScript({ bapId: f.bapId, address: BAP_REVOKED_ADDRESS, signer: bapKey(root, 0) })])
    recordPublishedIdentity(
      runtime(),
      rootId,
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(revoke)], {
        preferAlias: f.aliasTx.id('hex'),
      })!,
    )
    expect(issuanceSigner(runtime()).identity).toBeNull()
  })
  it('signing is on by default and the opt-out survives a reload', () => {
    expect(signsIssuance(runtime())).toBe(true)
    setSignsIssuance(runtime(), false)
    expect(signsIssuance(runtime())).toBe(false)
    importIssuerPrivateKey(runtime(), imported.toWif())
    expect(signsIssuance(runtime())).toBe(false)
    setSignsIssuance(runtime(), true)
    expect(signsIssuance(runtime())).toBe(true)
  })
  it('a backup carries the identity packages, so a fresh device can issue under the same BAP ID', async () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    const f = bapIdentityFixture({ master: imported, name: 'Imported studio' })
    recordPublishedIdentity(runtime(), importedId, f.pkg)
    const backup = JSON.parse(exportPublicIdentityBackup(runtime()))
    expect(backup.packages[f.bapId]).toEqual(f.pkg)
    state.values.clear()
    resetIssuerIdentitiesForTests()
    await restorePublicIdentityBackup(runtime(), backup)
    selectPublicIdentity(runtime(), importedId)
    expect(issuanceSigner(runtime())).toMatchObject({
      identityKey: importedId,
      rootKeyHex: imported.toHex().padStart(64, '0'),
      identity: { bapId: f.bapId, name: 'Imported studio' },
    })
    const corrupted = structuredClone(backup)
    corrupted.identities[0].sealedKey = 'AAAA'
    await expect(restorePublicIdentityBackup(runtime(), corrupted)).rejects.toThrow()
  })
  it('migrates v1 profile records to custody only', () => {
    const sealed = EncryptedMessage.encrypt(
      Utils.toArray(
        JSON.stringify({
          kind: 'issuer-signing-key',
          owner: rootId,
          privateKey: imported.toHex().padStart(64, '0'),
        }),
        'utf8',
      ),
      root,
      root.toPublicKey(),
    )
    state.values.set(
      accountLocalKeyFor(storageRegistry.publicIdentities.key, {
        identityKey: rootId,
        accountIndex: 0,
        chain: 'main',
      }),
      JSON.stringify({
        version: 1,
        owner: rootId,
        chain: 'main',
        selected: importedId,
        identities: [
          { profile: { identityKey: rootId, displayName: 'Old', icon: 'https://x.test/i.png' }, signer: 'wallet' },
          { profile: { identityKey: importedId }, signer: 'imported', sealedKey: Utils.toBase64(sealed) },
          { profile: { identityKey: '03'.padEnd(66, '1') }, signer: 'public' },
        ],
      }),
    )
    const rows = listPublicIdentities(runtime())
    expect(rows.map((row) => [row.identityKey, row.signer, row.identity])).toEqual([
      [rootId, 'wallet', null],
      [importedId, 'imported', null],
    ])
    expect(issuanceSigner(runtime()).rootKeyHex).toBe(imported.toHex().padStart(64, '0'))
  })
})
describe('presented identity', () => {
  it('shares a published BAP identity automatically, countersigned by the key it labels', () => {
    expect(presentedIdentityMaterial(runtime())).toBeNull()
    expect(presentedPublicIdentityKey(runtime())).toBeNull()
    expect(() => presentPublicIdentity(runtime(), rootId)).toThrow(/Add a profile/)
    const f = bapIdentityFixture({ master: root, name: 'Wallet studio' })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    expect(presentedPublicIdentityKey(runtime())).toBe(rootId)
    const material = presentedIdentityMaterial(runtime())
    expect(material).toMatchObject({
      kind: 'presented',
      identityKey: rootId,
      profile: { id: f.bapId, source: 'bap', name: 'Wallet studio' },
      pkg: { identityKey: rootId, bap: { bapId: f.bapId } },
    })
    expect(material?.kind === 'presented' && pub(material.signingKey)).toBe(rootId)
    expect(presentedIdentityMaterial(runtime())?.issuedAt).toBe(material!.issuedAt)
  })

  it('shares an existing published identity that was never presented', () => {
    const f = bapIdentityFixture({ master: root, name: 'Wallet studio' })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    const key = accountLocalKeyFor(storageRegistry.publicIdentities.key, { identityKey: rootId, accountIndex: 0, chain: 'main' })
    const { presented: _p, presentedAt: _at, ...unshared } = JSON.parse(state.values.get(key)!)
    state.values.set(key, JSON.stringify(unshared))
    expect(presentedIdentityMaterial(runtime())).toMatchObject({ kind: 'presented', profile: { id: f.bapId } })
  })

  it('removing the shared signer falls back to the wallet identity with a strictly later statement', () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    recordPublishedIdentity(runtime(), importedId, bapIdentityFixture({ master: imported, name: 'Imported studio' }).pkg)
    const shown = presentedIdentityMaterial(runtime())!
    expect(presentedPublicIdentityKey(runtime())).toBe(importedId)
    const own = bapIdentityFixture({ master: root, name: 'Wallet studio' })
    recordPublishedIdentity(runtime(), rootId, own.pkg)
    expect(presentedPublicIdentityKey(runtime())).toBe(importedId)
    removePublicIdentity(runtime(), importedId)
    const next = presentedIdentityMaterial(runtime())!
    expect(next).toMatchObject({ kind: 'presented', profile: { id: own.bapId } })
    expect(Date.parse(next.issuedAt)).toBeGreaterThan(Date.parse(shown.issuedAt))
    presentPublicIdentity(runtime(), rootId)
    expect(presentedIdentityMaterial(runtime())?.issuedAt).toBe(next.issuedAt)
  })

  it('withdraws only when no published identity is left', () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    recordPublishedIdentity(runtime(), importedId, bapIdentityFixture({ master: imported, name: 'Imported studio' }).pkg)
    const shown = presentedIdentityMaterial(runtime())!
    removePublicIdentity(runtime(), importedId)
    const withdrawn = presentedIdentityMaterial(runtime())!
    expect(withdrawn.kind).toBe('withdrawn')
    expect(Date.parse(withdrawn.issuedAt)).toBeGreaterThan(Date.parse(shown.issuedAt))
    expect(presentedPublicIdentityKey(runtime())).toBeNull()
  })

  it('reads any vault account profile without unlocking it', () => {
    expect(accountProfile({ identityKey: rootId, accountIndex: 0, chain: 'main' })).toBeNull()
    const f = bapIdentityFixture({ master: root, name: 'Wallet studio' })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    state.active = active(imported)
    expect(accountProfile({ identityKey: rootId, accountIndex: 0, chain: 'main' })).toMatchObject({
      id: f.bapId,
      name: 'Wallet studio',
    })
    expect(accountProfile({ identityKey: rootId, accountIndex: 1, chain: 'main' })).toBeNull()
  })

  it('refuses a stored presentation that names a key this wallet does not control', () => {
    const key = accountLocalKeyFor(storageRegistry.publicIdentities.key, {
      identityKey: rootId,
      accountIndex: 0,
      chain: 'main',
    })
    state.values.set(
      key,
      JSON.stringify({
        version: 2,
        owner: rootId,
        chain: 'main',
        selected: rootId,
        identities: [],
        presented: importedId,
        presentedAt: '2026-09-01T00:00:00.000Z',
      }),
    )
    expect(() => listPublicIdentities(runtime())).toThrow(/not controlled/)
  })
})
describe("identity key's own profile", () => {
  const png = { contentType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 9, 9]) }

  it('saves without a transaction, labels the key ahead of its BAP identity, and is shared at once', async () => {
    const f = bapIdentityFixture({ master: root, name: 'BAP studio' })
    recordPublishedIdentity(runtime(), rootId, f.pkg)
    const saved = await saveIdentityProfile(runtime(), rootId, { name: 'Studio', description: 'Prints' }, png)
    expect(saved).toMatchObject({ id: rootId, source: 'identity-key', name: 'Studio', bap: { bapId: f.bapId } })
    expect(listPublicIdentities(runtime())[0]).toMatchObject({ profile: { id: rootId, name: 'Studio' } })
    expect(displayIssuerProfile(runtime(), { issuer: rootId })).toMatchObject({ id: rootId, name: 'Studio' })
    expect(displayIssuerProfile(runtime(), { issuer: pub(f.signer), bapId: f.bapId })).toMatchObject({
      id: rootId,
      name: 'Studio',
    })
    expect(accountProfile({ identityKey: rootId, accountIndex: 0, chain: 'main' })).toMatchObject({ id: rootId, name: 'Studio' })
    const material = presentedIdentityMaterial(runtime())
    expect(material).toMatchObject({ kind: 'presented', identityKey: rootId, profile: { id: rootId } })
    const pkg = parseIdentityKeyPackage(material?.kind === 'presented' ? material.pkg : null)!
    expect(pkg.bap?.bapId).toBe(f.bapId)
    expect((await profileFromPackage(pkg))?.profile).toMatchObject({ identityKey: rootId, name: 'Studio' })
  })

  it('a profile alone is enough to present a key, and each save is strictly later than the last', async () => {
    importIssuerPrivateKey(runtime(), imported.toWif())
    expect(() => presentPublicIdentity(runtime(), importedId)).toThrow(/Add a profile/)
    await saveIdentityProfile(runtime(), importedId, { name: 'Imported', description: '' }, null)
    const first = identityProfileFor('main', importedId)!
    presentPublicIdentity(runtime(), importedId)
    expect(presentedPublicIdentityKey(runtime())).toBe(importedId)
    const material = presentedIdentityMaterial(runtime())
    expect(material?.kind === 'presented' && pub(material.signingKey)).toBe(importedId)
    const again = await saveIdentityProfile(runtime(), importedId, { name: 'Imported 2', description: '' }, null)
    expect(Date.parse(identityProfileFor('main', importedId)!.issuedAt)).toBeGreaterThan(Date.parse(first.issuedAt))
    expect(again.name).toBe('Imported 2')
    await expect(
      saveIdentityProfile(runtime(), pub(PrivateKey.fromRandom()), { name: 'Stranger', description: '' }, null),
    ).rejects.toThrow(/does not control/)
  })

  it('a backup carries the profiles, and a restore keeps only those that verify for a key it controls', async () => {
    await saveIdentityProfile(runtime(), rootId, { name: 'Studio', description: '' }, png)
    const backup = JSON.parse(exportPublicIdentityBackup(runtime()))
    expect(Object.keys(backup.profiles)).toEqual([rootId.toLowerCase()])
    state.values.clear()
    resetIdentityProfilesForTests()
    const forged = structuredClone(backup)
    forged.profiles[rootId.toLowerCase()].certificate.fields.name = 'Swapped'
    await restorePublicIdentityBackup(runtime(), forged)
    expect(identityProfileFor('main', rootId)).toBeNull()
    await restorePublicIdentityBackup(runtime(), backup)
    expect(identityProfileFor('main', rootId)).toMatchObject({ name: 'Studio' })
    expect(Array.from(identityProfileFor('main', rootId)!.image!.bytes)).toEqual(Array.from(png.bytes))
  })
})
