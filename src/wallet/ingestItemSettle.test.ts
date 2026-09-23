import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  internalizePeerItemSettle,
  itemSettleIsSelfSend,
  pickTipVoutForOriginHint,
} from './ingestItemSettle'

const mocks = vi.hoisted(() => ({
  signedChequeAtomic: vi.fn(() => null as number[] | null),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

vi.mock('./signedChequeArchive', () => ({
  signedChequeAtomic: mocks.signedChequeAtomic,
}))

vi.mock('./inscriptionCache', () => ({
  rememberResolvedInscription: vi.fn(),
  getResolvedInscription: vi.fn(() => null),
  getResolvedInscriptionByOrigin: vi.fn(() => null),
}))

describe('internalizePeerItemSettle', () => {
  beforeEach(() => {
    mocks.signedChequeAtomic.mockReset()
    mocks.signedChequeAtomic.mockReturnValue(null)
  })

  it('refuses an invalid txid without touching the wallet', async () => {
    expect(await internalizePeerItemSettle({ txid: 'nope' })).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-txid',
    })
  })

  it('refuses when the wallet is locked', async () => {
    const txid = 'a'.repeat(64)
    expect(await internalizePeerItemSettle({ txid, tx: [1, 2, 3] })).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'locked',
    })
  })

  it('recognizes an account-scoped signed cheque as a self-send', () => {
    const txid = 'b'.repeat(64)
    mocks.signedChequeAtomic.mockReturnValue([1, 2, 3])
    expect(itemSettleIsSelfSend(txid)).toBe(true)
    expect(mocks.signedChequeAtomic).toHaveBeenCalledWith(txid)
  })
})

describe('pickTipVoutForOriginHint', () => {
  const txid = 'ab'.repeat(32)

  beforeEach(async () => {
    const cache = await import('./inscriptionCache')
    vi.mocked(cache.getResolvedInscription).mockReturnValue(null)
  })

  it('maps tip-shaped hints onto the matching vout', () => {
    expect(pickTipVoutForOriginHint(txid, [0, 1], `${txid}_1`)).toBe(1)
    expect(pickTipVoutForOriginHint(txid, [0, 1], `${txid}.0`)).toBe(0)
  })

  it('assigns a genesis hint to the first tip still on its default origin', async () => {
    const cache = await import('./inscriptionCache')
    vi.mocked(cache.getResolvedInscription).mockImplementation((op) => {
      if (op === `${txid}.0`) {
        return {
          origin: 'cd'.repeat(32) + '_0',
          name: 'Fox A',
          traits: [],
          extras: [],
        }
      }
      return null
    })
    expect(
      pickTipVoutForOriginHint(txid, [0, 1], `${'ef'.repeat(32)}_0`),
    ).toBe(1)
  })
})
