import { describe, expect, it } from 'vitest'
import { chooseOrdinalMigratePath } from './ordinalMigratePath'

// The ordinal indexer lists every unspent output an address holds. A Yours
// branch returned a 1,679,834-sat cash output alongside its inscriptions, and
// signing it as a 1-sat tip failed script evaluation on every retry.

const OURS = '76a914aabbccddeeff00112233445566778899aabbccdd88ac'
const THEIRS = '76a914ffffffffffffffffffffffffffffffffffffffff88ac'

/**
 * A real tip from the phrase we were handed: bare P2PKH followed by an
 * `OP_RETURN` Sigma signature. Requiring the lock to *equal* a bare P2PKH
 * refused every one of these.
 */
const SIGMA_TIP = `${OURS}6a0553494758`
const hexOf = (text: string) => Buffer.from(text, 'utf8').toString('hex')
const push = (text: string) =>
  `${text.length.toString(16).padStart(2, '0')}${hexOf(text)}`
/** `OP_FALSE OP_IF "ord" OP_1 <type> OP_0 <body> OP_ENDIF`. */
const envelope = (contentType: string, body: string) =>
  `0063036f726451${push(contentType)}00${push(body)}68`

/** 1Sat inscription envelope ahead of the P2PKH. */
const INSCRIBED_TIP = `${envelope('text/plain', 'hi')}${OURS}`
/** The same envelope after the P2PKH, as some minters write it. */
const TRAILING_INSCRIPTION_TIP = `${OURS}${envelope('image/png', 'x')}`
const BSV21_TIP = `${envelope('application/bsv-20', '{"p":"bsv-20","op":"transfer","id":"aa_0","amt":"5"}')}${OURS}`
const BSV20_TIP = `${envelope('application/bsv-20', '{"p":"bsv-20","op":"transfer","tick":"PEPE","amt":"5"}')}${OURS}`
/** Sigil v1: collection hash lock, then the owner's P2PKH, then metadata. */
const SIGIL_V1_TIP = `a914${'11'.repeat(20)}88${OURS}6a${push('{"name":"Twonk #1"}')}`

describe('chooseOrdinalMigratePath', () => {
  it('migrates a 1-sat tip locked to the phrase key', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: OURS }, OURS),
    ).toEqual({ path: 'migrate', satoshis: 1 })
  })

  it('migrates a tip whose P2PKH carries a Sigma signature', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: SIGMA_TIP }, OURS),
    ).toEqual({ path: 'migrate', satoshis: 1 })
  })

  it('migrates a tip whose inscription envelope precedes the P2PKH', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: INSCRIBED_TIP }, OURS),
    ).toEqual({ path: 'migrate', satoshis: 1 })
  })

  it('refuses a cash output the indexer listed with the ordinals', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1_679_834, lockingScriptHex: OURS }, OURS),
    ).toEqual({ path: 'skip', reason: 'notOneSat' })
  })

  it('refuses a tip this key cannot unlock', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: THEIRS }, OURS),
    ).toEqual({ path: 'skip', reason: 'foreignLock' })
  })

  it('refuses an output that could not be read from the tip BEEF', () => {
    expect(chooseOrdinalMigratePath(null, OURS)).toEqual({
      path: 'skip',
      reason: 'unreadable',
    })
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: null }, OURS),
    ).toEqual({ path: 'skip', reason: 'unreadable' })
  })

  it('migrates a tip whose inscription follows the P2PKH', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: TRAILING_INSCRIPTION_TIP }, OURS),
    ).toEqual({ path: 'migrate', satoshis: 1 })
  })

  it('refuses BSV-21 and BSV-20 tokens — a bare 1-sat output would burn them', () => {
    for (const lockingScriptHex of [BSV21_TIP, BSV20_TIP]) {
      expect(chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex }, OURS)).toEqual({
        path: 'skip',
        reason: 'token',
      })
    }
  })

  it('refuses a RUN jig even though its script is a bare P2PKH', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: OURS, runJig: true }, OURS),
    ).toEqual({ path: 'skip', reason: 'runJig' })
  })

  it('refuses a contract that merely contains the key (Sigil v1)', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: SIGIL_V1_TIP }, OURS),
    ).toEqual({ path: 'skip', reason: 'covenant' })
  })

  it('refuses an incomplete envelope ahead of the P2PKH', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: `0063036f726451${OURS}` }, OURS),
    ).toEqual({ path: 'skip', reason: 'covenant' })
  })

  it('ignores lock hex casing', () => {
    expect(
      chooseOrdinalMigratePath(
        { satoshis: 1, lockingScriptHex: OURS.toUpperCase() },
        OURS,
      ).path,
    ).toBe('migrate')
  })
})
