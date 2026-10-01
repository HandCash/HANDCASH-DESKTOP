import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { bapAliasScript, bapIdScript, bapKey, BAP_REVOKED_ADDRESS } from './bapRecords'
import { beefOf, bapIdentityFixture, PNG_1PX, recordTx, rotationTx } from './issuerIdentity.fixture'
import {
  bapKeyChain,
  buildIssuerIdentityPackage,
  currentIssuerSigningKey,
  issuerIdentityPackageBeef,
  issuerIdentityPackageRoots,
  issuerProfile,
  issuerSignerVerdict,
  parseIssuerIdentityPackage,
  verifyIssuerIdentityPackage,
} from './issuerIdentity'

const pub = (key: PrivateKey) => key.toPublicKey().toString()

describe('issuer identity packages', () => {
  it('verifies a first publish: root declares identity-1, which signs the profile and B:// image', () => {
    const f = bapIdentityFixture({ name: 'Studio', description: 'We make things' })
    const identity = verifyIssuerIdentityPackage(f.pkg)
    expect(identity).toMatchObject({
      bapId: f.bapId,
      rootAddress: bapKey(f.master, 0).toAddress(),
      keys: [{ seq: 1, address: f.signer.toAddress(), txid: f.aliasTx.id('hex') }],
      name: 'Studio',
      description: 'We make things',
      imageTxid: f.imageTx.id('hex'),
      alias: { txid: f.aliasTx.id('hex'), signer: f.signer.toAddress() },
    })
    expect(identity!.image).toEqual(PNG_1PX)
    expect(identity!.revoked).toBeUndefined()
  })

  it('carries exactly the records a verifier needs, with unmined parents as txid-only', () => {
    const f = bapIdentityFixture({})
    const unrelated = recordTx([bapAliasScript({ bapId: f.bapId, profile: { name: 'x' }, signer: PrivateKey.fromRandom() })])
    const pkg = buildIssuerIdentityPackage(f.bapId, [...f.beefs, beefOf(unrelated)])!
    expect(pkg.beefB64).toBe(f.pkg.beefB64)
    expect(issuerIdentityPackageRoots(pkg)).toEqual([])
  })

  it('refuses packages that are malformed, mislabelled or rootless', () => {
    const f = bapIdentityFixture({})
    expect(parseIssuerIdentityPackage({ ...f.pkg, v: 2 })).toBeNull()
    expect(verifyIssuerIdentityPackage({ ...f.pkg, bapId: bapIdentityFixture({}).bapId })).toBeNull()
    expect(verifyIssuerIdentityPackage({ ...f.pkg, beefB64: 'AAAA' })).toBeNull()
    const impostor = PrivateKey.fromRandom()
    const orphan = recordTx([
      bapIdScript({ bapId: f.bapId, address: impostor.toAddress(), signer: impostor }),
      bapAliasScript({ bapId: f.bapId, profile: { name: 'Impostor' }, signer: impostor }),
    ])
    expect(buildIssuerIdentityPackage(f.bapId, [beefOf(orphan)])).toBeNull()
  })

  it('a rotation keeps the BAP ID and moves authority to the next key', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const { tx, next } = rotationTx(f, 1, { name: 'Studio II', minedHeight: 900_020 })
    const pkg = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!
    const identity = verifyIssuerIdentityPackage(pkg)!
    expect(identity.bapId).toBe(f.bapId)
    expect(identity.keys.map((k) => [k.seq, k.address, k.minedHeight])).toEqual([
      [1, f.signer.toAddress(), 900_010],
      [2, next.toAddress(), 900_020],
    ])
    expect(identity.name).toBe('Studio II')
    expect(identity.alias.signer).toBe(next.toAddress())
    expect(currentIssuerSigningKey(f.master, identity).toHex()).toBe(next.toHex())
    expect(() => currentIssuerSigningKey(PrivateKey.fromRandom(), identity)).toThrow(/not derived/)
    expect(issuerIdentityPackageRoots(pkg)!.map((r) => r.height).sort()).toEqual([900_010, 900_020])
  })

  it('a retired key speaks only for assets mined before its successor', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const { tx, next } = rotationTx(f, 1, { minedHeight: 900_020 })
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!,
    )!
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_015)).toBe('active')
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_020)).toBe('retired-key')
    expect(issuerSignerVerdict(identity, pub(f.signer))).toBe('retired-key')
    expect(issuerSignerVerdict(identity, pub(next), 900_030)).toBe('active')
    expect(issuerSignerVerdict(identity, pub(next))).toBe('active')
    expect(issuerSignerVerdict(identity, pub(PrivateKey.fromRandom()))).toBe('unknown-key')
    expect(issuerSignerVerdict(identity, 'nope')).toBe('unknown-key')
  })

  it('an unmined rotation does not yet retire the outgoing key', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const { tx } = rotationTx(f, 1)
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!,
    )!
    expect(identity.keys).toHaveLength(2)
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_050)).toBe('active')
    expect(issuerSignerVerdict(identity, pub(f.signer))).toBe('active')
  })

  it('the first rotation on chain wins over a later fork by a leaked key', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const honest = rotationTx(f, 1, { name: 'Studio', minedHeight: 900_020 })
    const thief = PrivateKey.fromRandom()
    const fork = recordTx(
      [
        bapIdScript({ bapId: f.bapId, address: thief.toAddress(), signer: f.signer }),
        bapAliasScript({ bapId: f.bapId, profile: issuerProfile({ name: 'Thief', description: '' }, f.imageTx.id('hex')), signer: thief }),
      ],
      900_030,
    )
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(fork), beefOf(honest.tx)])!,
    )!
    expect(identity.keys.at(-1)!.address).toBe(honest.next.toAddress())
    expect(identity.name).toBe('Studio')
    expect(issuerSignerVerdict(identity, pub(thief), 900_040)).toBe('unknown-key')
  })

  it('two unmined rival rotations leave the chain at the last agreed key', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const a = rotationTx(f, 1)
    const thief = PrivateKey.fromRandom()
    const b = recordTx([bapIdScript({ bapId: f.bapId, address: thief.toAddress(), signer: f.signer })])
    expect(bapKeyChain(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(a.tx), beefOf(b)])!.keys).toHaveLength(1)
  })

  it('a root-signed revoke ends attribution from its height', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const revoke = recordTx(
      [bapIdScript({ bapId: f.bapId, address: BAP_REVOKED_ADDRESS, signer: bapKey(f.master, 0) })],
      900_020,
    )
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(revoke)])!,
    )!
    expect(identity.revoked).toEqual({ txid: revoke.id('hex'), minedHeight: 900_020 })
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_015)).toBe('active')
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_020)).toBe('revoked')
    expect(issuerSignerVerdict(identity, pub(f.signer))).toBe('revoked')
  })

  it('an unmined revoke still builds a package that shows the revocation', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const revoke = recordTx([bapIdScript({ bapId: f.bapId, address: BAP_REVOKED_ADDRESS, signer: bapKey(f.master, 0) })])
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(revoke)])!,
    )!
    expect(identity.revoked).toEqual({ txid: revoke.id('hex') })
    expect(identity.name).toBe('Studio')
    expect(issuerSignerVerdict(identity, pub(f.signer), 900_015)).toBe('revoked')
  })

  it('a revoke signed by a non-root key is ignored', () => {
    const f = bapIdentityFixture({})
    const revoke = recordTx([bapIdScript({ bapId: f.bapId, address: BAP_REVOKED_ADDRESS, signer: f.signer })])
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(revoke)])!,
    )!
    expect(identity.revoked).toBeUndefined()
  })

  it('a profile update reuses the image file instead of carrying a second copy', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const update = recordTx(
      [bapAliasScript({ bapId: f.bapId, profile: issuerProfile({ name: 'Renamed', description: '' }, f.imageTx.id('hex')), signer: f.signer })],
      900_020,
    )
    const pkg = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(update)])!
    const identity = verifyIssuerIdentityPackage(pkg)!
    expect(identity.name).toBe('Renamed')
    expect(identity.imageTxid).toBe(f.imageTx.id('hex'))
    expect(identity.image).toEqual(PNG_1PX)
  })

  describe('which profile is current, decided from the records alone', () => {
    const update = (f: ReturnType<typeof bapIdentityFixture>, name: string, signer: PrivateKey, minedHeight?: number) =>
      recordTx(
        [bapAliasScript({ bapId: f.bapId, profile: issuerProfile({ name, description: '' }, f.imageTx.id('hex')), signer })],
        minedHeight,
      )
    const current = (f: ReturnType<typeof bapIdentityFixture>, ...txs: ReturnType<typeof recordTx>[]) =>
      verifyIssuerIdentityPackage(
        buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), ...txs.map((tx) => beefOf(tx))]),
      )?.name

    it('an unmined update supersedes the mined first profile', () => {
      const f = bapIdentityFixture({ aliasHeight: 900_010 })
      expect(current(f, update(f, 'Updated', f.signer))).toBe('Updated')
    })
    it('a standalone update supersedes the profile written beside its key declaration', () => {
      const f = bapIdentityFixture({})
      expect(current(f, update(f, 'Updated', f.signer))).toBe('Updated')
    })
    it('between mined updates, the higher block wins', () => {
      const f = bapIdentityFixture({ aliasHeight: 900_010 })
      expect(current(f, update(f, 'Later', f.signer, 900_030), update(f, 'Earlier', f.signer, 900_020))).toBe('Later')
    })
    it("a later key's profile supersedes an earlier key's, whatever their blocks", () => {
      const f = bapIdentityFixture({ aliasHeight: 900_010 })
      const { tx } = rotationTx(f, 1, { name: 'Next key' })
      expect(current(f, tx, update(f, 'Old key update', f.signer))).toBe('Next key')
    })
  })

  it('ignores an ALIAS signed by a key the chain never declared', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const stray = recordTx(
      [bapAliasScript({ bapId: f.bapId, profile: { name: 'Stray' }, signer: PrivateKey.fromRandom() })],
      900_020,
    )
    const identity = verifyIssuerIdentityPackage(
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(stray)])!,
    )!
    expect(identity.name).toBe('Studio')
  })

  it('reads the key chain of records whose ALIAS has no usable profile', () => {
    const f = bapIdentityFixture({})
    const legacy = recordTx([
      bapIdScript({ bapId: f.bapId, address: f.signer.toAddress(), signer: bapKey(f.master, 0) }),
      bapAliasScript({ bapId: f.bapId, profile: { '@type': 'Person' }, signer: f.signer }),
    ])
    expect(buildIssuerIdentityPackage(f.bapId, [beefOf(legacy)])).toBeNull()
    expect(bapKeyChain(f.bapId, [beefOf(legacy)])).toMatchObject({
      rootAddress: bapKey(f.master, 0).toAddress(),
      keys: [{ seq: 1, address: f.signer.toAddress() }],
    })
  })

  it('keeps an identity whose legacy profile names its image by URL, without the image', () => {
    const f = bapIdentityFixture({})
    const legacy = recordTx([
      bapIdScript({ bapId: f.bapId, address: f.signer.toAddress(), signer: bapKey(f.master, 0) }),
      bapAliasScript({ bapId: f.bapId, profile: { '@type': 'Person', name: 'Old', image: 'https://example.com/a.png' }, signer: f.signer }),
    ])
    const identity = verifyIssuerIdentityPackage(buildIssuerIdentityPackage(f.bapId, [beefOf(legacy)]))!
    expect(identity.name).toBe('Old')
    expect(identity.image).toBeUndefined()
    expect(identity.imageTxid).toBeUndefined()
  })
})
