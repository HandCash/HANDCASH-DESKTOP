import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listed = { messageId: string; sender: string; plaintext: string | null }
let listed: Listed[] = []
let acked: string[] = []
const ingest = vi.fn<(sender: string, notice: unknown) => Promise<'recorded' | 'refused'>>()
let heldElsewhere: string | null = null

vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: { rootKeyHex: '11'.repeat(32), identityKey: '02' + '22'.repeat(32) } }) }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => heldElsewhere }))
vi.mock('../coinMethods', () => ({ coinWalletOf: async () => ({ ingestPaymentNotice: ingest }) }))
vi.mock('../messageTransport', () => ({
  listSealedOwnBox: async () => listed,
  acknowledgeOwnBox: async (_root: string, _box: string, ids: string[]) => {
    acked.push(...ids)
  },
}))

const { parseCoinPaymentNotice, resetCoinPaymentBoxForTest, serveCoinPaymentBox } = await import('./coinPaymentBox')

const notice = (txid: string) => JSON.stringify({ v: 1, t: 'coin-payment', chain: 'btc', txid, vout: 0, keyId: 'ab'.repeat(16) })
const sender = '03' + '33'.repeat(32)

beforeEach(() => {
  listed = []
  acked = []
  heldElsewhere = null
  ingest.mockReset()
  resetCoinPaymentBoxForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('box coin-payment (BRC-213 §7)', () => {
  it('parses only well-formed notices for a chain the wallet holds', () => {
    expect(parseCoinPaymentNotice(notice('aa'.repeat(32)))).toMatchObject({ chain: 'btc', vout: 0 })
    expect(parseCoinPaymentNotice(null)).toBeNull()
    expect(parseCoinPaymentNotice('not json')).toBeNull()
    expect(parseCoinPaymentNotice(JSON.stringify({ v: 1, t: 'coin-payment', chain: 'eth', txid: 'aa', vout: 0, keyId: 'x' }))).toBeNull()
  })

  it('acknowledges a notice once recorded or refused, and unreadable messages at once', async () => {
    ingest.mockResolvedValueOnce('recorded').mockResolvedValueOnce('refused')
    listed = [
      { messageId: 'm1', sender, plaintext: notice('aa'.repeat(32)) },
      { messageId: 'm2', sender, plaintext: notice('bb'.repeat(32)) },
      { messageId: 'm3', sender, plaintext: null },
    ]
    await serveCoinPaymentBox({ force: true })
    expect(acked.sort()).toEqual(['m1', 'm2', 'm3'])
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(ingest.mock.calls[0]![0]).toBe(sender)
  })

  it('keeps a notice whose transaction cannot be read yet, and drops it after a day', async () => {
    ingest.mockRejectedValue(new Error('transaction not found'))
    listed = [{ messageId: 'm1', sender, plaintext: notice('aa'.repeat(32)) }]
    const start = Date.now()
    await serveCoinPaymentBox({ force: true })
    expect(acked).toEqual([])
    vi.spyOn(Date, 'now').mockReturnValue(start + 24 * 60 * 60_000 + 1)
    await serveCoinPaymentBox({ force: true })
    expect(acked).toEqual(['m1'])
  })

  it('an account held on another device neither reads nor acknowledges the box', async () => {
    heldElsewhere = 'held on another device'
    listed = [{ messageId: 'm1', sender, plaintext: notice('aa'.repeat(32)) }]
    await serveCoinPaymentBox({ force: true })
    expect(ingest).not.toHaveBeenCalled()
    expect(acked).toEqual([])
  })
})
