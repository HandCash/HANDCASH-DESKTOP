import { PrivateKey, StorageUtils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  IDENTITY_PROFILE_CERT_TYPE,
  identityKeyPackage,
  parseIdentityKeyPackage,
  profileFromPackage,
  signIdentityProfile,
  verifyIdentityProfile,
} from './identityProfile'

const master = PrivateKey.fromHex('11'.repeat(32))
const identityKey = master.toPublicKey().toString().toLowerCase()
const png = { contentType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]) }

describe('identity profile (BRC-248 §2 self-published certificate)', () => {
  it('signs a profile the identity key certifies about itself, readable by anyone', async () => {
    const { record, profile } = await signIdentityProfile({
      master,
      fields: { name: 'Brandon', description: 'Builds wallets' },
      image: png,
      issuedAt: '2026-10-14T12:00:00.000Z',
    })
    expect(record.certificate.type).toBe(IDENTITY_PROFILE_CERT_TYPE)
    expect(record.certificate.subject).toBe(identityKey)
    expect(record.certificate.certifier).toBe(identityKey)
    expect(StorageUtils.isValidURL(record.image!.url)).toBe(true)
    expect(profile).toMatchObject({ identityKey, name: 'Brandon', description: 'Builds wallets' })
    expect(Array.from(profile.image!.bytes)).toEqual(Array.from(png.bytes))
  })

  it('round-trips through a v2 package', async () => {
    const { record } = await signIdentityProfile({
      master,
      fields: { name: 'Brandon', description: '' },
      image: png,
      issuedAt: '2026-10-14T12:00:00.000Z',
    })
    const pkg = parseIdentityKeyPackage(JSON.parse(JSON.stringify(identityKeyPackage(identityKey, { profile: record }))))
    const found = await profileFromPackage(pkg!)
    expect(found?.profile.name).toBe('Brandon')
    expect(found?.profile.image).toBeDefined()
  })

  it('refuses a profile another key certified, a swapped image and a forged field', async () => {
    const { record } = await signIdentityProfile({
      master,
      fields: { name: 'Brandon', description: '' },
      image: png,
      issuedAt: '2026-10-14T12:00:00.000Z',
    })
    const other = PrivateKey.fromHex('22'.repeat(32)).toPublicKey().toString().toLowerCase()
    expect(await verifyIdentityProfile(other, record.certificate, [record.image!])).toBeNull()
    const swapped = { ...record.image!, bytesB64: Buffer.from([9, 9, 9]).toString('base64') }
    expect(await verifyIdentityProfile(identityKey, record.certificate, [swapped])).toBeNull()
    expect(await verifyIdentityProfile(identityKey, record.certificate, [])).toBeNull()
    const forged = { ...record.certificate, fields: { ...record.certificate.fields, name: record.certificate.fields.issuedAt! } }
    expect(await verifyIdentityProfile(identityKey, forged, [record.image!])).toBeNull()
  })

  it('keeps the newest of two profiles in one package', async () => {
    const older = await signIdentityProfile({ master, fields: { name: 'Old', description: '' }, issuedAt: '2026-10-01T00:00:00.000Z' })
    const newer = await signIdentityProfile({ master, fields: { name: 'New', description: '' }, issuedAt: '2026-10-02T00:00:00.000Z' })
    const found = await profileFromPackage({
      v: 2,
      identityKey,
      certificates: [newer.record.certificate, older.record.certificate],
    })
    expect(found?.profile.name).toBe('New')
  })

  it('refuses an email address as a name and a profile dated in the future', async () => {
    await expect(
      signIdentityProfile({ master, fields: { name: 'me@example.com', description: '' }, issuedAt: '2026-10-14T12:00:00.000Z' }),
    ).rejects.toThrow()
    const { record } = await signIdentityProfile({
      master,
      fields: { name: 'Later', description: '' },
      issuedAt: '2026-10-14T12:00:00.000Z',
    })
    expect(
      await verifyIdentityProfile(identityKey, record.certificate, [], { now: Date.parse('2026-10-14T11:00:00.000Z') }),
    ).toBeNull()
  })
})
