import { HD } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  HandCashKeyring,
  describeKeyPairProblem,
  describeKeyProblem,
  extractExtendedKeys,
  parseExtendedPrivateKey,
} from './handcashShares'

/** BIP-32 test vectors 1 and 2 masters, used as the two exported shares. */
const SHARE_ONE =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
const SHARE_TWO =
  'xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U'

/**
 * From HandCash/recovery-tool `scripts/reference/tss_reference.py` — a
 * standard-library Python implementation sharing no code with this one.
 */
const REFERENCE = {
  'm/0/0': { address: '1LkcACs528gaqBWgvcEUVnYGwQQUKpuePQ', wif: 'L3ujiNTFqrvxAEHpHDTbsVy9JDj95rNpFhje4DvocWDYyT7t4i8n' },
  'm/3/0': { address: '1P624wXhkRRLXUmNQXsoRPXx4WkNCJ42yt', wif: 'L3h8BZ7p3ZLte8QfznvntorpbhHEzAVTiYjmZMCqUd1qsKRysQn6' },
  'm/4/12': { address: '125KHQTjxSHApu4D5YHTFt6FcBKcNkyedr', wif: 'L1QfhfWRDbQLQbQrGD1hHdYNntJJtc4NyXfyHJBAciyHWtZBiXd2' },
  'm/9/7': { address: '198HTBsBXAhc9WHUTaXE8sT5PDJy1MnbuY', wif: 'L239TSZ4wkm51KqB613j3bwTUMnVcWBXZXcqcD4a3XEz3c1VoMPB' },
  'm/0/2147483647': { address: '1QEFMnKRpaxjfjvtzJonM2YoVYEY4noHpQ', wif: 'L28Cg4DkhgyPY8ALFn1byZnZ2aMwQBoU13Pa3w1DjZS15bA3Ujhi' },
} as const

describe('HandCash two-key export', () => {
  const keyring = HandCashKeyring.fromExtendedKeys(SHARE_ONE, SHARE_TWO)

  it.each(Object.entries(REFERENCE))('composes the reference key at %s', (path, expected) => {
    const key = keyring.privateKeyAt(path)
    expect(key.toPublicKey().toAddress()).toBe(expected.address)
    expect(key.toWif()).toBe(expected.wif)
  })

  it('does not depend on key order', () => {
    const swapped = HandCashKeyring.fromExtendedKeys(SHARE_TWO, SHARE_ONE)
    expect(swapped.privateKeyAt('m/3/0').toWif()).toBe(keyring.privateKeyAt('m/3/0').toWif())
  })

  it('never collapses to a single share', () => {
    const shareOnly = HD.fromString(SHARE_ONE).derive('m/3/0').privKey.toWif()
    expect(keyring.privateKeyAt('m/3/0').toWif()).not.toBe(shareOnly)
  })

  it('refuses what cannot recover a wallet', () => {
    const xpub = HD.fromString(SHARE_ONE).toPublic().toString()
    expect(parseExtendedPrivateKey(xpub)).toBeNull()
    expect(describeKeyProblem(xpub)).toContain('public key')
    const typo = `${SHARE_ONE.slice(0, 40)}${SHARE_ONE[40] === 'a' ? 'b' : 'a'}${SHARE_ONE.slice(41)}`
    expect(parseExtendedPrivateKey(typo)).toBeNull()
    expect(parseExtendedPrivateKey(SHARE_ONE.slice(0, -1))).toBeNull()
    expect(describeKeyPairProblem(SHARE_ONE, ` ${SHARE_ONE}`)).toContain('same key')
    expect(describeKeyPairProblem(SHARE_ONE, typo)?.startsWith('Second key')).toBe(true)
    expect(describeKeyPairProblem(typo, SHARE_TWO)?.startsWith('First key')).toBe(true)
  })

  it('splits an export pasted as one block', () => {
    const pasted = `Key 1:\n${SHARE_ONE}\n\nKey 2: ${SHARE_TWO}\n`
    expect(extractExtendedKeys(pasted)).toEqual([SHARE_ONE, SHARE_TWO])
  })
})
