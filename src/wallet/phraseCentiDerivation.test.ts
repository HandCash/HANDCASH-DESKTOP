import { HD, Mnemonic } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  buildCentiPhraseCandidates,
  CENTI_ADDRESS_COUNT,
} from './phraseSweep'

/** Public BIP39 vector — never use as a real wallet. */
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function expectedAddress(path: string, passphrase = ''): string {
  const seed = Mnemonic.fromString(PHRASE).toSeed(passphrase)
  return HD.fromSeed(seed).derive(path).privKey.toAddress()
}

describe('Centi phrase derivation', () => {
  it('derives receive leaves under the tester-confirmed 145 account', () => {
    const candidates = buildCentiPhraseCandidates(PHRASE)
    const first = candidates.find((candidate) => candidate.path === "m/44'/145'/0'/0/0")
    const second = candidates.find((candidate) => candidate.path === "m/44'/145'/0'/0/1")

    expect(first).toMatchObject({
      scheme: 'centi-receive',
      label: 'Centi receive #0',
      address: expectedAddress("m/44'/145'/0'/0/0"),
    })
    expect(second?.address).toBe(expectedAddress("m/44'/145'/0'/0/1"))
    expect(second?.rootKeyHex).not.toBe(first?.rootKeyHex)
  })

  it('derives the separate change chain', () => {
    const candidates = buildCentiPhraseCandidates(PHRASE)
    const change = candidates.find((candidate) => candidate.path === "m/44'/145'/0'/1/1")

    expect(change).toMatchObject({
      scheme: 'centi-change',
      label: 'Centi change #1',
      address: expectedAddress("m/44'/145'/0'/1/1"),
    })
    expect(change?.address).not.toBe(expectedAddress("m/44'/145'/0'/0/1"))
  })

  it('checks exactly twenty leaves on both chains', () => {
    const candidates = buildCentiPhraseCandidates(PHRASE)
    expect(candidates).toHaveLength(CENTI_ADDRESS_COUNT * 2)
    expect(new Set(candidates.map((candidate) => candidate.address)).size).toBe(
      candidates.length,
    )
    expect(candidates.at(-1)?.path).toBe("m/44'/145'/0'/1/19")
  })

  it('preserves the BIP39 passphrase and never exceeds the hard bound', () => {
    const passphrase = 'TREZOR'
    const one = buildCentiPhraseCandidates(PHRASE, passphrase, 1)
    expect(one).toHaveLength(2)
    expect(one[0]?.address).toBe(
      expectedAddress("m/44'/145'/0'/0/0", passphrase),
    )
    expect(buildCentiPhraseCandidates(PHRASE, '', 10_000)).toHaveLength(
      CENTI_ADDRESS_COUNT * 2,
    )
  })
})
