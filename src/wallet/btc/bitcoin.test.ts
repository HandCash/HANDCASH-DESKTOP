import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, memoryLtcHeaderStore, type HeaderSource } from '../ltc/headers'
import { fromHex, ltcTxid, merkleRootFromProof, parseLtcHeader, parseLtcTx, toHex } from '../ltc/litecoin'
import { COIN_INFO } from '../coins/coinChains'
import { BTC_RETARGET_INTERVAL, btcCoinAddress, btcCoinScript, btcOutputScript, formatBtc, nextBtcBits } from './bitcoin'
import { BTC_PROOF_RULES } from './btcWallet'
import fixture from './fixtures/chain.json'
import { BTC_BURIAL_DEPTH, BTC_CHECKPOINT, BTC_HEADER_RULES } from './headers'

const START = fixture.start
const RETARGET = fixture.retarget
const raws = Array.from({ length: fixture.hex.length / 160 }, (_, i) => fromHex(fixture.hex.slice(i * 160, i * 160 + 160)))
const parsed = raws.map(parseLtcHeader)
const LAST = START + raws.length - 1
const NOW = (parsed[parsed.length - 1]!.time + 600) * 1000
const at = (height: number) => parsed[height - START]!
const windowFirst = parseLtcHeader(fromHex(fixture.windowFirst))
const before = parseLtcHeader(fromHex(fixture.before))

const checkpoint: LtcCheckpoint = {
  height: START,
  hash: at(START).hash,
  bits: at(START).bits,
  time: at(START).time,
  windowEnds: { [RETARGET - BTC_RETARGET_INTERVAL]: windowFirst.time },
}

function sourceOf(edit?: (height: number, raw: Uint8Array) => Uint8Array): HeaderSource {
  return {
    tipHeight: async () => LAST,
    headerPage: async () => {
      throw new Error('ranges only')
    },
    headerRange: async (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => (edit ? edit(lo + i, raws[lo + i - START]!) : raws[lo + i - START]!)),
  }
}

const chainOf = (source: HeaderSource, cp = checkpoint) =>
  createHeaderChain({ rules: BTC_HEADER_RULES, source, checkpoint: cp, store: memoryLtcHeaderStore(), now: () => NOW })

describe('Bitcoin addresses', () => {
  it('pays BIP173 and BIP350 addresses and P2SH, and refuses a 1… address that would read as BSV', () => {
    expect(toHex(btcOutputScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6')
    expect(toHex(btcOutputScript('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'))).toBe(
      '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
    expect(toHex(btcOutputScript('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'))).toBe('a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87')
    expect(() => btcOutputScript('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toThrow()
    expect(() => btcOutputScript('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9')).toThrow()
  })

  it('receives on its own P2WPKH address, whose script is what it pays', () => {
    const pub = Uint8Array.from(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const address = btcCoinAddress(pub)
    expect(address.startsWith('bc1q')).toBe(true)
    expect(toHex(btcOutputScript(address))).toBe(toHex(btcCoinScript(pub)))
  })

  it('formats satoshis as BTC', () => {
    expect(formatBtc(150_000_000n)).toBe('1.5')
    expect(formatBtc(1n)).toBe('0.00000001')
  })
})

describe('Bitcoin header chain', () => {
  it('ships a checkpoint whose window start is the first block of its retarget window', () => {
    const first = Number(Object.keys(BTC_CHECKPOINT.windowEnds)[0])
    expect(first).toBe(BTC_CHECKPOINT.height - (BTC_CHECKPOINT.height % BTC_RETARGET_INTERVAL))
    expect(BTC_CHECKPOINT.hash).toMatch(/^0{16}[0-9a-f]{48}$/)
  })

  it('computes the real retarget at 971712 from its window', () => {
    expect(nextBtcBits(at(RETARGET - 1).bits, at(RETARGET - 1).time, windowFirst.time)).toBe(at(RETARGET).bits)
    expect(before.hash).toBe(at(START).prevHash)
  })

  it('syncs real blocks across a retarget and buries a coin three deep', async () => {
    const chain = chainOf(sourceOf())
    expect(await chain.check(fixture.tx.height, at(fixture.tx.height).hash, BTC_BURIAL_DEPTH)).toEqual({ kind: 'buried' })
    expect(await chain.tipHeight()).toBe(LAST)
  })

  it('takes no retarget header whose bits are not what its window gives', async () => {
    const chain = chainOf(
      sourceOf((h, raw) => {
        if (h !== RETARGET) return raw
        const out = Uint8Array.from(raw)
        out[72] ^= 1
        return out
      }),
    )
    expect(await chain.check(RETARGET - 2, at(RETARGET - 2).hash, 3)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/Bitcoin header \d+ refused: bits/) })
  })

  it('cannot check a retarget without the time its window started', async () => {
    const chain = chainOf(sourceOf(), { ...checkpoint, windowEnds: {} })
    expect(await chain.check(RETARGET, at(RETARGET).hash, 3)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/no-window/) })
  })
})

describe('Bitcoin coin proof', () => {
  it('reads a real transaction and proves it into its block', () => {
    const tx = BTC_PROOF_RULES.parseTx(fromHex(fixture.tx.raw))
    expect(ltcTxid(tx)).toBe(fixture.tx.txid)
    expect(ltcTxid(parseLtcTx(fromHex(fixture.tx.raw)))).toBe(fixture.tx.txid)
    expect(toHex(merkleRootFromProof(fixture.tx.txid, fixture.tx.merkle, fixture.tx.pos))).toBe(toHex(at(fixture.tx.height).merkleRoot))
  })

  it('confirms coins at the depth the views count', () => {
    expect(BTC_PROOF_RULES.depth).toBe(COIN_INFO.btc.confirmations)
  })
})
