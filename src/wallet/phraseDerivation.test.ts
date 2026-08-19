import { describe, expect, it } from 'vitest'
import { HD, Mnemonic } from '@bsv/sdk'
import {
  keyFromMnemonicHdPath,
  rootKeyFromMnemonicLegacyHd,
} from './vault'

// Yours / Panda keeps ordinals on m/44'/236'/1'/0/0 — a child branch, not the
// seed root. Sweeping the root address found no items; these lock in that we
// derive the real ordinal branch and that it differs from the master key.

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const YOURS_ORD_PATH = "m/44'/236'/1'/0/0"
const YOURS_WALLET_PATH = "m/44'/236'/0'/1/0"

function expectedAddress(path: string): string {
  const seed = Mnemonic.fromString(MNEMONIC).toSeed()
  const node = HD.fromSeed(seed).derive(path)
  return node.privKey.toAddress()
}

describe('foreign HD derivation', () => {
  it('derives the Yours ordinal branch, not the seed root', () => {
    const master = rootKeyFromMnemonicLegacyHd(MNEMONIC)
    const ord = keyFromMnemonicHdPath(MNEMONIC, YOURS_ORD_PATH)
    expect(ord.address).toBe(expectedAddress(YOURS_ORD_PATH))
    expect(ord.address).not.toBe(master.address)
  })

  it('separates the Yours wallet branch from the ordinal branch', () => {
    const wallet = keyFromMnemonicHdPath(MNEMONIC, YOURS_WALLET_PATH)
    const ord = keyFromMnemonicHdPath(MNEMONIC, YOURS_ORD_PATH)
    expect(wallet.address).toBe(expectedAddress(YOURS_WALLET_PATH))
    expect(wallet.address).not.toBe(ord.address)
  })

  it('treats path "m" as the master key', () => {
    const master = rootKeyFromMnemonicLegacyHd(MNEMONIC)
    const viaPath = keyFromMnemonicHdPath(MNEMONIC, 'm')
    expect(viaPath.address).toBe(master.address)
  })
})
