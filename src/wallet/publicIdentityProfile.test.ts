import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  profileFromRemittance,
  signPublicIdentityProfile,
  verifyPublicIdentityProfile,
} from './publicIdentityProfile'

const root = PrivateKey.fromHex('01'.padStart(64, '0'))
const fields = {
  displayName: 'Example issuer',
  icon: 'https://example.test/avatar.png',
  description: 'Collectibles and achievements',
}
describe('signed public profiles', () => {
  it('verifies only the key, network and exact fields signed by the issuer', () => {
    const profile = signPublicIdentityProfile(root.toHex(), 'main', fields)
    expect(
      verifyPublicIdentityProfile(
        profile,
        root.toPublicKey().toString(),
        'main',
      ),
    ).toEqual(profile)
    expect(verifyPublicIdentityProfile(profile, undefined, 'test')).toBeNull()
    expect(
      verifyPublicIdentityProfile(
        profile,
        PrivateKey.fromHex('02').toPublicKey().toString(),
      ),
    ).toBeNull()
    for (const change of [
      { displayName: 'Imposter' },
      { icon: 'https://attacker.test/icon' },
      { updatedAt: profile.updatedAt + 1 },
      { extra: 'not signed' },
      { signature: '00'.repeat(70) },
    ])
      expect(verifyPublicIdentityProfile({ ...profile, ...change })).toBeNull()
  })
  it('requires a safe icon and a bounded name, and accepts inscription icons', () => {
    for (const icon of [
      'http://example.test/icon',
      'javascript:alert(1)',
      'https://user:password@example.test/icon',
      'data:image/png;base64,abc',
      '',
    ])
      expect(() =>
        signPublicIdentityProfile(root.toHex(), 'main', { ...fields, icon }),
      ).toThrow()
    expect(() =>
      signPublicIdentityProfile(root.toHex(), 'main', {
        ...fields,
        displayName: 'x'.repeat(81),
      }),
    ).toThrow()
    expect(
      verifyPublicIdentityProfile(
        signPublicIdentityProfile(root.toHex(), 'test', {
          ...fields,
          icon: `ord://${'ab'.repeat(32)}_0`,
        }),
      ),
    ).not.toBeNull()
  })
  it('does not accept an embedded profile without a matching issuer claim', () => {
    const issuerProfile = signPublicIdentityProfile(
      root.toHex(),
      'main',
      fields,
    )
    expect(profileFromRemittance(JSON.stringify({ issuerProfile }))).toBeNull()
    expect(
      profileFromRemittance(
        JSON.stringify({ issuer: issuerProfile.identityKey, issuerProfile }),
      ),
    ).toEqual(issuerProfile)
  })
})
