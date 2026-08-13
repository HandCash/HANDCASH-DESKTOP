import { describe, expect, it } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import {
  chooseSendPath,
  classifyTipKind,
  hasSpendableP2pkhBranch,
  isCovenantLockedScript,
  lockingScriptHexFromBeef,
  normalizeLockingScriptHex,
  resolveTipLockingScriptHex,
} from './collectableTipKind'

const P2PKH_HEX = `76a914${'ab'.repeat(20)}88ac`
const COVENANT = `01${'cd'.repeat(100)}` // non-P2PKH, long enough
const ORD_PREFIX =
  '0063036f7264010118746578742f706c61696e3b636861727365743d7574662d380003666f6f68'
const INSCRIBED = `${ORD_PREFIX}${P2PKH_HEX}`
const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('normalizeLockingScriptHex', () => {
  it('strips 0x and leaves bare hex', () => {
    expect(normalizeLockingScriptHex(`0x${P2PKH_HEX}`)).toBe(P2PKH_HEX)
    expect(normalizeLockingScriptHex(P2PKH_HEX)).toBe(P2PKH_HEX)
  })

  it('calls toHex on script objects', () => {
    expect(normalizeLockingScriptHex({ toHex: () => `0x${P2PKH_HEX}` })).toBe(
      P2PKH_HEX,
    )
  })
})

describe('lockingScriptHexFromBeef', () => {
  it('recovers a tip locking script when listOutputs omitted it', () => {
    const key = PrivateKey.fromRandom()
    const address = key.toPublicKey().toAddress()
    const script = new P2PKH().lock(address).toHex()
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(address) })
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    const outpoint = `${tx.id('hex')}.0`

    expect(lockingScriptHexFromBeef(beef.toBinary(), outpoint)).toBe(script)
    expect(
      resolveTipLockingScriptHex({
        listed: undefined,
        beefBin: beef.toBinary(),
        outpoint,
      }),
    ).toBe(script)
    expect(classifyTipKind(script).kind).toBe('p2pkh')
  })
})

describe('classifyTipKind', () => {
  it('labels P2PKH as p2pkh', () => {
    expect(classifyTipKind(P2PKH_HEX)).toEqual({
      kind: 'p2pkh',
      lockingScript: P2PKH_HEX,
    })
  })

  it('labels 0x-prefixed P2PKH as p2pkh', () => {
    expect(classifyTipKind(`0x${P2PKH_HEX}`).kind).toBe('p2pkh')
  })

  it('labels inscribed (ord + P2PKH) tips as p2pkh', () => {
    expect(hasSpendableP2pkhBranch(INSCRIBED)).toBe(true)
    expect(classifyTipKind(INSCRIBED)).toEqual({
      kind: 'p2pkh',
      lockingScript: INSCRIBED,
    })
    expect(isCovenantLockedScript(INSCRIBED)).toBe(false)
  })

  it('labels long non-P2PKH as covenantLocked', () => {
    expect(classifyTipKind(COVENANT).kind).toBe('covenantLocked')
    expect(isCovenantLockedScript(COVENANT)).toBe(true)
    expect(isCovenantLockedScript(P2PKH_HEX)).toBe(false)
  })

  it('returns unknown for empty script', () => {
    expect(classifyTipKind('')).toEqual({ kind: 'unknown' })
    expect(classifyTipKind(null)).toEqual({ kind: 'unknown' })
  })
})

describe('chooseSendPath', () => {
  it('refuses covenant tips (must abandon)', () => {
    const tipKind = classifyTipKind(COVENANT)
    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: null,
      }),
    ).toMatchObject({
      path: 'refuse',
      reason: expect.stringMatching(/abandon/i),
    })

    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: IDENTITY,
      }).path,
    ).toBe('refuse')
  })

  it('sends proven P2PKH regardless of identity', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH_HEX),
        provenTier: 'brc150',
        recipientIdentityKey: IDENTITY,
      }),
    ).toEqual({ path: 'p2pkhSend' })
  })

  it('sends inscribed P2PKH tips', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(INSCRIBED),
      }),
    ).toEqual({ path: 'p2pkhSend' })
  })

  it('sends unproven P2PKH (or missing identity)', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH_HEX),
        provenTier: 'unproven',
        recipientIdentityKey: IDENTITY,
      }),
    ).toEqual({ path: 'p2pkhSend' })

    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH_HEX),
        provenTier: 'brc150',
        recipientIdentityKey: null,
      }),
    ).toEqual({ path: 'p2pkhSend' })
  })

  it('refuses unknown tip kinds without authenticity', () => {
    expect(
      chooseSendPath({
        tipKind: { kind: 'unknown' },
        recipientIdentityKey: IDENTITY,
      }),
    ).toMatchObject({ path: 'refuse' })
  })

  it('sends unknown tips that already verified BRC-150', () => {
    expect(
      chooseSendPath({
        tipKind: { kind: 'unknown' },
        provenTier: 'brc150',
      }),
    ).toEqual({ path: 'p2pkhSend' })
  })

  it('still refuses covenant even when BRC-150 is proven', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(COVENANT),
        provenTier: 'brc150',
      }).path,
    ).toBe('refuse')
  })
})
