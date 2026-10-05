import { HD, Mnemonic, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { keyDeriverFor, parseImportSecret, sourceFingerprint, IMPORT_SOURCE_KINDS } from './importSource'
import { templatePath, templateWalks, HANDCASH_TEMPLATES, PHRASE_TEMPLATES } from './pathCatalog'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SHARE_ONE =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
const SHARE_TWO =
  'xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U'

describe('import source vocabulary', () => {
  it('lists HandCash first', () => {
    expect(IMPORT_SOURCE_KINDS[0]).toBe('handcash')
  })

  it('splits a HandCash export pasted into one field', () => {
    const parsed = parseImportSecret('handcash', { primary: `${SHARE_ONE}\n${SHARE_TWO}` })
    expect(parsed).toEqual({ ok: true, secret: { kind: 'handcash', first: SHARE_ONE, second: SHARE_TWO } })
  })

  it('names the bad HandCash field', () => {
    const parsed = parseImportSecret('handcash', { primary: SHARE_ONE, secondary: 'xpub123' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.startsWith('Second key')).toBe(true)
  })

  it('normalises and checks phrases', () => {
    const parsed = parseImportSecret('twetch', { primary: `  ${PHRASE.toUpperCase()}  ` })
    expect(parsed).toEqual({ ok: true, secret: { kind: 'twetch', mnemonic: PHRASE, passphrase: '' } })
    const bad = parseImportSecret('phrase', { primary: PHRASE.replace('about', 'abandon') })
    expect(bad.ok).toBe(false)
  })

  it('accepts several WIF keys and rejects junk', () => {
    const a = PrivateKey.fromRandom().toWif()
    const b = PrivateKey.fromRandom().toWif()
    expect(parseImportSecret('wif', { primary: `${a}\n${b}, ${a}` })).toEqual({
      ok: true,
      secret: { kind: 'wif', wifs: [a, b] },
    })
    expect(parseImportSecret('wif', { primary: 'Knot-a-key' }).ok).toBe(false)
  })

  it('reads a Yours export with keys and phrase', () => {
    const payPk = PrivateKey.fromRandom().toWif()
    const ordPk = PrivateKey.fromRandom().toWif()
    const parsed = parseImportSecret('yours', {
      primary: JSON.stringify({ mnemonic: PHRASE, payPk, ordPk, payDerivationPath: "m/44'/236'/0'/1/0" }),
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.secret.kind !== 'yours') return
    expect(parsed.secret.keys.map((k) => k.role)).toEqual(['pay', 'ord'])
    const deriver = keyDeriverFor(parsed.secret)
    expect(deriver.privateKeyAt('yours:ord').toWif()).toBe(ordPk)
    expect(deriver.templates).toBe(PHRASE_TEMPLATES)
    expect(parseImportSecret('yours', { primary: '{}' }).ok).toBe(false)
    expect(parseImportSecret('yours', { primary: 'not json' }).ok).toBe(false)
  })
})

describe('key derivers', () => {
  it('derives phrase paths exactly as BIP32 does, hardened included', () => {
    const deriver = keyDeriverFor({ kind: 'phrase', mnemonic: PHRASE, passphrase: '' })
    const master = HD.fromSeed(Mnemonic.fromString(PHRASE).toSeed(''))
    for (const path of ["m/44'/236'/0'/0/7", "m/0'/0'/3'", 'm/1/4', 'm/9', "m/44'/236'/2'/0/0"]) {
      expect(deriver.privateKeyAt(path).toWif()).toBe(master.derive(path).privKey.toWif())
    }
    expect(deriver.privateKeyAt('m').toWif()).toBe(master.privKey.toWif())
    expect(deriver.fixed.map((k) => k.path)).toEqual(['brc75'])
  })

  it('gives Twetch a display identity at m/0/0 and nothing else', () => {
    const deriver = keyDeriverFor({ kind: 'twetch', mnemonic: PHRASE, passphrase: '' })
    expect(deriver.identity).toEqual({ label: 'Twetch identity', path: 'm/0/0' })
  })

  it('walks HandCash roots m/0 … m/9 with the wide gap', () => {
    const deriver = keyDeriverFor({ kind: 'handcash', first: SHARE_ONE, second: SHARE_TWO })
    expect(deriver.templates).toBe(HANDCASH_TEMPLATES)
    expect(HANDCASH_TEMPLATES.map((t) => templatePath(t, null, 0))).toEqual(
      Array.from({ length: 10 }, (_, i) => `m/${i}/0`),
    )
    expect(HANDCASH_TEMPLATES.filter((t) => t.itemsRoot).map((t) => t.id)).toEqual(['handcash-m9'])
    expect(deriver.privateKeyAt('m/0/0').toPublicKey().toAddress()).toBe('1LkcACs528gaqBWgvcEUVnYGwQQUKpuePQ')
  })

  it('recognises a second save of the same wallet', () => {
    const a = sourceFingerprint({ kind: 'phrase', mnemonic: PHRASE, passphrase: '' })
    const b = sourceFingerprint({ kind: 'phrase', mnemonic: PHRASE, passphrase: 'x' })
    expect(a).not.toBe(b)
    expect(sourceFingerprint({ kind: 'phrase', mnemonic: PHRASE, passphrase: '' })).toBe(a)
  })

  it('expands branches into separate walks', () => {
    const walks = templateWalks(PHRASE_TEMPLATES.filter((t) => t.id === 'bip44-bsv'))
    expect(walks.map((w) => w.label)).toEqual([
      'BSV (BIP44) · receive',
      'BSV (BIP44) · change',
      'BSV (BIP44) · branch 2',
    ])
  })
})
