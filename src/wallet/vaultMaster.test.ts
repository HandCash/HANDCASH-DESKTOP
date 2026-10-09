import { Mnemonic, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  accountIdentityKey,
  accountRootKeyHex,
  brc157Mnemonic,
  brc157VaultMaster,
  brc157VaultMasterFromKey,
  brc42VaultMaster,
  parseVaultMaster,
  sameVaultMaster,
  vaultIdentityKey,
} from './vaultMaster'

const WORDS_12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const WORDS_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'

describe('BRC-157 vault master (accounts are profiles m/0\'/n\')', () => {
  it('matches the BRC-157 worked example for profile 0 of a 12-word phrase', () => {
    const master = brc157VaultMaster(Mnemonic.fromString(WORDS_12).toEntropy())
    expect(master).toEqual({
      derivation: 'brc-157',
      keyHex: '000000000000000000000000000000007f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
      entropyLength: 16,
    })
    expect(accountRootKeyHex(master, 0)).toBe('27e442c8015fc055789d6628f3b30461e8b2598aff74dc87ceef00dd8e670e55')
    expect(accountRootKeyHex(master, 1)).toBe('8d5bd9de4d42da1ee10fa7d09f14ba13512b4725844e9f936bdc35b9cb9e17dc')
    expect(brc157Mnemonic(master).toString()).toBe(WORDS_12)
  })

  it('derives the profiles of a 24-word phrase', () => {
    const master = brc157VaultMaster(Mnemonic.fromString(WORDS_24).toEntropy())
    expect(accountRootKeyHex(master, 0)).toBe('4303939e04ef918fa573d990df9897c7cf59e12820ec23b9892ce2c482d8aea0')
    expect(accountRootKeyHex(master, 1)).toBe('2f7c7332643e37919578e6dde41ac248cbeaf25729e61b5c03c877d19893be6b')
    expect(accountIdentityKey(master, 2)).toBe('02bda138d95a4ac8dba67198700b3eeb0cf87710a792425d5e5f3a4e414d32a8d1')
    expect(vaultIdentityKey(master)).toBe('03bc1b7e076b075a9c159c0b2a66ad7589585ade3a097c802f343076914c3b0586')
  })

  it('never uses the entropy key as an account', () => {
    const master = brc157VaultMaster(Mnemonic.fromString(WORDS_24).toEntropy())
    expect(accountRootKeyHex(master, 0)).not.toBe(master.keyHex)
  })

  it('refuses zero, out-of-range and odd-length entropy', () => {
    expect(() => brc157VaultMaster(Array(16).fill(0))).toThrow(/range/)
    expect(() => brc157VaultMaster(Array(32).fill(0xff))).toThrow(/range/)
    expect(() => brc157VaultMaster(Array(17).fill(1))).toThrow(/16 to 32/)
  })

  it('reads a reconstructed key by BRC-157\'s length heuristic', () => {
    const twelve = brc157VaultMaster(Mnemonic.fromString(WORDS_12).toEntropy())
    expect(brc157VaultMasterFromKey(twelve.keyHex)).toEqual(twelve)
    const full = brc157VaultMaster(PrivateKey.fromRandom().toArray('be', 32))
    if (full.keyHex.startsWith('00')) return
    expect(brc157VaultMasterFromKey(full.keyHex)).toEqual(full)
  })

  it('round-trips through stored fields and refuses a length the key does not fit', () => {
    const master = brc157VaultMaster(Mnemonic.fromString(WORDS_24).toEntropy())
    const parsed = parseVaultMaster({ keyHex: master.keyHex, derivation: 'brc-157', entropyLength: 32 })
    expect(sameVaultMaster(parsed, master)).toBe(true)
    expect(() => parseVaultMaster({ keyHex: master.keyHex, derivation: 'brc-157', entropyLength: 16 })).toThrow(
      /recorded length/,
    )
    expect(() => parseVaultMaster({ keyHex: master.keyHex, derivation: 'brc-999' })).toThrow(/Unsupported/)
  })
})

describe('BRC-42 vault master (older vaults)', () => {
  const ROOT = '1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250'

  it('keeps the root as account 0 and matches the BRC-208 vectors', () => {
    const master = brc42VaultMaster(ROOT)
    expect(accountRootKeyHex(master, 0)).toBe(ROOT)
    expect(accountRootKeyHex(master, 1)).toBe('ba883e48fc890f89b6fee2c7f7f2ff727468c8bc525f364511ecbd5d90d619e5')
    expect(accountIdentityKey(master, 2)).toBe('0329e91b2bf9109a829e8e8217df43e6e793fa32ab45a13cf6387e85ba05e4ae4d')
  })

  it('treats a stored secret without a derivation as BRC-42', () => {
    expect(parseVaultMaster({ keyHex: ROOT })).toEqual(brc42VaultMaster(ROOT))
  })

  it('opens different accounts from the same key than BRC-157 does', () => {
    expect(vaultIdentityKey(brc42VaultMaster(ROOT))).not.toBe(vaultIdentityKey(brc157VaultMasterFromKey(ROOT)))
  })
})
