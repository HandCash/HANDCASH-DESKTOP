import { describe, expect, it } from 'vitest'
import {
  rootKeyFromMnemonicBrc75,
  rootKeyFromMnemonicLegacyHd,
} from './vault'

/** Fixed BIP39 vector — do not use as a real wallet. */
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('mnemonic derivation', () => {
  it('BRC-75 and legacy HD produce different master keys for the same phrase', () => {
    const brc75 = rootKeyFromMnemonicBrc75(PHRASE)
    const legacy = rootKeyFromMnemonicLegacyHd(PHRASE)
    expect(brc75.scheme).toBe('brc-75')
    expect(legacy.scheme).toBe('legacy-hd')
    expect(brc75.rootKeyHex).not.toBe(legacy.rootKeyHex)
    expect(brc75.identityKey).not.toBe(legacy.identityKey)
    expect(brc75.rootKeyHex).toHaveLength(64)
  })

  it('is deterministic for a given phrase + passphrase', () => {
    const a = rootKeyFromMnemonicBrc75(PHRASE, 'TREZOR')
    const b = rootKeyFromMnemonicBrc75(PHRASE, 'TREZOR')
    const c = rootKeyFromMnemonicBrc75(PHRASE)
    expect(a.rootKeyHex).toBe(b.rootKeyHex)
    expect(a.rootKeyHex).not.toBe(c.rootKeyHex)
  })
})
