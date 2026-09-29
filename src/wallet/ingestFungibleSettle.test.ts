import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeBsv21Binary } from './token/decode162'
import { p2pkhScriptHex } from './ordinalOwnership'
import {
  collectFungibleTipsPayingUs,
  internalizePeerFungibleSettle,
} from './token/settle'

const atomicBeefForSubject = vi.fn()
const completeAtomicBeefForSubject = vi.fn()
const internalizeAction = vi.fn()

vi.mock('./beefCache', () => ({
  atomicBeefForSubject: (...args: unknown[]) => atomicBeefForSubject(...args),
  completeAtomicBeefForSubject: (...args: unknown[]) =>
    completeAtomicBeefForSubject(...args),
  rememberBeefTree: vi.fn(),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    address: '1receiver',
    wallet: { internalizeAction },
  }),
}))

const TOKEN_ID = `${'ab'.repeat(32)}_0`

beforeEach(() => {
  atomicBeefForSubject.mockReset()
  completeAtomicBeefForSubject.mockReset()
  internalizeAction.mockReset()
})

describe('internalizePeerFungibleSettle', () => {
  it('refuses an invalid txid before touching the wallet', async () => {
    expect(
      await internalizePeerFungibleSettle({
        txid: 'nope',
        token: {
          kind: 'fungible',
          tokenId: TOKEN_ID,
          amount: '10',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-txid',
    })
  })

  it('refuses malformed token remittance before touching the wallet', async () => {
    expect(
      await internalizePeerFungibleSettle({
        txid: 'cd'.repeat(32),
        token: {
          kind: 'fungible',
          tokenId: 'bad',
          amount: '0',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-token-remittance',
    })
  })

  it('re-frames peer BEEF for the fungible subject before ingest', async () => {
    const txid = 'cd'.repeat(32)
    const plainBeef = [1, 2, 3]
    atomicBeefForSubject.mockReturnValue(undefined)

    await expect(
      internalizePeerFungibleSettle({
        txid,
        tx: plainBeef,
        beefPurpose: 'inboundItemHint',
        token: {
          kind: 'fungible',
          tokenId: TOKEN_ID,
          amount: '10',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).resolves.toEqual({
      accepted: false,
      outpoints: [],
      reason: 'missing-beef',
    })

    expect(atomicBeefForSubject).toHaveBeenCalledWith(plainBeef, txid)
  })

  it('names the missing parents instead of handing the toolbox a package it will refuse', async () => {
    // hc-a580a, 438497125f03: the sender's lean package lacked an unproven
    // parent, so internalizeAction threw "a complete, exactly framed Atomic
    // BEEF transaction" three times a poll for two days. Completion runs first
    // and a still-missing parent is a named, retryable refusal.
    const txid = 'cd'.repeat(32)
    const parent = 'ef'.repeat(32)
    const framed = [9, 9, 9]
    atomicBeefForSubject.mockReturnValue(framed)
    completeAtomicBeefForSubject.mockResolvedValue({
      atomic: framed,
      missing: [parent],
      completed: [],
    })

    await expect(
      internalizePeerFungibleSettle({
        txid,
        tx: framed,
        beefPurpose: 'inboundItemHint',
        token: {
          kind: 'fungible',
          tokenId: TOKEN_ID,
          amount: '10',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).resolves.toEqual({
      accepted: false,
      outpoints: [],
      reason: `ancestry-incomplete:${parent.slice(0, 12)}`,
    })

    expect(completeAtomicBeefForSubject).toHaveBeenCalledWith(
      expect.objectContaining({ address: '1receiver' }),
      framed,
      txid,
    )
    expect(internalizeAction).not.toHaveBeenCalled()
  })
})

const SELF = '19aXSPsoR45Uuxk4LUonJ672zGFf57wfrD'
const OTHER = '1BitcoinEaterAddressDontSendf59kuE'
const SELF_TOKEN = `${'cd'.repeat(32)}_0`

function tokenOutput(amount: bigint, address: string) {
  return {
    satoshis: 1 as const,
    lockingScript: encodeBsv21Binary({
      tokenId: SELF_TOKEN,
      amount,
      rest: p2pkhScriptHex(address),
    }),
  }
}

describe('collectFungibleTipsPayingUs', () => {
  it('accepts both outputs of a self-send when the payment and the change are the same amount', () => {
    const { tips } = collectFungibleTipsPayingUs({
      outputs: [
        tokenOutput(500n, SELF),
        { satoshis: 12_000, lockingScript: encodeBsv21Binary({ amount: 1n, rest: p2pkhScriptHex(SELF) }) },
        tokenOutput(500n, SELF),
      ],
      address: SELF,
      tokenId: SELF_TOKEN,
      amount: '500',
    })
    expect(tips.map((tip) => tip.vout)).toEqual([0, 2])
    expect(tips.every((tip) => tip.encoding === 'binary')).toBe(true)
  })

  it('leaves a different-amount change for the sender and keeps only the payment', () => {
    const { tips } = collectFungibleTipsPayingUs({
      outputs: [tokenOutput(300n, OTHER), tokenOutput(700n, SELF)],
      address: OTHER,
      tokenId: SELF_TOKEN,
      amount: '300',
    })
    expect(tips.map((tip) => tip.vout)).toEqual([0])
  })
})
