import { describe, expect, it } from 'vitest'
import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, memoryLtcHeaderStore, type HeaderSource } from '../ltc/headers'
import { concat, fromHex, ltcTxid, merkleRootFromProof, Reader, sha256d, targetFromBits, toHex } from '../ltc/litecoin'
import { COIN_INFO } from '../coins/coinChains'
import { electrumCoinChain } from '../coins/electrumChain'
import { DOGE_ELECTRUM } from './chain'
import {
  dogeCoinAddress,
  dogeCoinScript,
  dogeOutputScript,
  dogePowHash,
  legacySighash,
  nextDogeBits,
  parseDogeHeader,
  parseDogeTx,
  serializeDogeTx,
  signP2pkhLegacyInputs,
  splitDogeHeaders,
} from './dogecoin'
import { DOGE_PROOF_RULES } from './dogeWallet'
import fixture from './fixtures/chain.json'
import { DOGE_BURIAL_DEPTH, DOGE_CHECKPOINT, DOGE_HEADER_RULES } from './headers'

const START = fixture.start
const raws = fixture.headers.map(fromHex)
const parsed = raws.map(parseDogeHeader)
const LAST = START + raws.length - 1
const NOW = (parsed[parsed.length - 1]!.time + 60) * 1000
const at = (height: number) => parsed[height - START]!

const checkpoint: LtcCheckpoint = {
  height: START + 1,
  hash: at(START + 1).hash,
  bits: at(START + 1).bits,
  time: at(START + 1).time,
  windowEnds: { [START]: at(START).time },
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
  createHeaderChain({ rules: DOGE_HEADER_RULES, source, checkpoint: cp, store: memoryLtcHeaderStore(), now: () => NOW })

describe('Dogecoin headers', () => {
  it('splits headers served with their AuxPoW and links each to the one before', () => {
    const joined = concat(...raws)
    expect(splitDogeHeaders(joined, raws.length).map(toHex)).toEqual(fixture.headers)
    expect(() => splitDogeHeaders(concat(joined, Uint8Array.of(0)), raws.length)).toThrow()
    for (let h = START + 1; h <= LAST; h++) expect(at(h).prevHash).toBe(at(h - 1).hash)
  })

  it('finds the work of every real merge-mined header under its own target', () => {
    for (const header of parsed) {
      expect(raws[parsed.indexOf(header)]!.length).toBeGreaterThan(80)
      expect(dogePowHash(header.raw) <= targetFromBits(header.bits)!).toBe(true)
    }
  })

  it('gives a header whose AuxPoW does not commit to it no work', () => {
    const raw = Uint8Array.from(raws[3]!)
    raw[4] ^= 1 // the previous-block hash: the block hash changes, the parent's commitment does not
    expect(dogePowHash(raw)).toBe(1n << 256n)
  })

  it('gives a header without Dogecoin\'s chain id no work', () => {
    const raw = Uint8Array.from(raws[3]!)
    raw[2] = 0x63
    expect(dogePowHash(raw)).toBe(1n << 256n)
  })

  it('retargets every block by DigiShield, exactly as the chain did', () => {
    for (let h = START + 2; h <= LAST; h++) {
      expect(nextDogeBits(at(h - 1).bits, at(h - 1).time, at(h - 2).time)).toBe(at(h).bits)
    }
  })

  it('ships a checkpoint that carries its parent\'s time', () => {
    expect(DOGE_CHECKPOINT.windowEnds).toHaveProperty(String(DOGE_CHECKPOINT.height - 1))
    expect(DOGE_CHECKPOINT.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Dogecoin header chain', () => {
  it('syncs real merge-mined blocks and buries a coin twenty deep', async () => {
    const chain = chainOf(sourceOf())
    expect(await chain.check(fixture.tx.height, at(fixture.tx.height).hash, DOGE_BURIAL_DEPTH)).toEqual({ kind: 'buried' })
    expect(await chain.tipHeight()).toBe(LAST)
  })

  it('takes no header whose bits are not DigiShield\'s', async () => {
    const chain = chainOf(
      sourceOf((h, raw) => {
        if (h !== START + 6) return raw
        const out = Uint8Array.from(raw)
        out[72] ^= 1
        return out
      }),
    )
    expect(await chain.check(START + 3, at(START + 3).hash, 3)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/Dogecoin header \d+ refused: bits/) })
  })

  it('takes no header whose AuxPoW was swapped for another block\'s', async () => {
    const chain = chainOf(
      sourceOf((h, raw) => (h === START + 6 ? concat(raw.slice(0, 80), raws[10]!.slice(80)) : raw)),
    )
    expect(await chain.check(START + 3, at(START + 3).hash, 3)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/Dogecoin header \d+ refused: pow/) })
  })

  it('reads AuxPoW headers from an Electrum server, in calls small enough for it', async () => {
    const calls: Array<[number, number]> = []
    const chain = electrumCoinChain(async (method, params) => {
      if (method !== 'blockchain.block.headers') throw new Error(`unexpected ${method}`)
      const [start, count] = params as [number, number]
      calls.push([start, count])
      return { count, hex: fixture.headers.slice(start - START, start - START + count).join('') }
    }, { ...DOGE_ELECTRUM, maxHeadersPerCall: 10 })
    const got = await chain.headerRange(START, LAST)
    expect(got.map(toHex)).toEqual(fixture.headers)
    expect(calls).toEqual([[START, 10], [START + 10, 10], [START + 20, 10], [START + 30, 2]])
    expect(toHex(await chain.header(await chain.blockHashAt(START + 5)))).toBe(fixture.headers[5]!.slice(0, 160))
  })
})

describe('Dogecoin transactions', () => {
  it('reads a real transaction and proves it into its block', () => {
    const tx = DOGE_PROOF_RULES.parseTx(fromHex(fixture.tx.raw))
    expect(ltcTxid(tx)).toBe(fixture.tx.txid)
    expect(toHex(serializeDogeTx(tx))).toBe(fixture.tx.raw)
    expect(toHex(merkleRootFromProof(fixture.tx.txid, fixture.tx.merkle, fixture.tx.pos))).toBe(toHex(at(fixture.tx.height).merkleRoot))
  })

  it('computes the legacy signature hash a real spend was signed over', () => {
    const tx = parseDogeTx(fromHex(fixture.tx.raw))
    const prev = parseDogeTx(fromHex(fixture.tx.prevRaw))
    const prevTxid = ltcTxid(prev)
    const vin = tx.inputs.findIndex((i) => i.txid === prevTxid && i.vout === fixture.tx.prevVout)
    expect(vin).toBeGreaterThanOrEqual(0)
    const r = new Reader(tx.inputs[vin]!.script)
    const sigWithType = r.bytes(r.u8())
    const pubkey = r.bytes(r.u8())
    expect(sigWithType[sigWithType.length - 1]).toBe(1)
    const digest = legacySighash(tx, vin, prev.outputs[fixture.tx.prevVout]!.script)
    const ok = ECDSA.verify(
      new BigNumber(toHex(digest), 16),
      Signature.fromDER(Array.from(sigWithType.slice(0, -1))),
      PublicKey.fromString(toHex(Uint8Array.from(pubkey))),
    )
    expect(ok).toBe(true)
  })

  it('signs a spend of its own coin that verifies under the same hash', () => {
    const key = PrivateKey.fromRandom()
    const pub = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    const unsigned = {
      version: 1,
      inputs: [{ txid: 'ab'.repeat(32), vout: 1, script: new Uint8Array(), sequence: 0xffffffff, witness: [] }],
      outputs: [{ value: 5_000_000n, script: dogeCoinScript(pub) }],
      locktime: 0,
    }
    const signed = signP2pkhLegacyInputs(unsigned, [key], [10_000_000n])
    const r = new Reader(signed.inputs[0]!.script)
    const sig = r.bytes(r.u8())
    expect(toHex(r.bytes(r.u8()))).toBe(toHex(pub))
    const digest = legacySighash(unsigned, 0, dogeCoinScript(pub))
    expect(ECDSA.verify(new BigNumber(toHex(digest), 16), Signature.fromDER(Array.from(sig.slice(0, -1))), key.toPublicKey())).toBe(true)
    expect(toHex(sha256d(serializeDogeTx(signed)))).toHaveLength(64)
  })

  it('refuses a transaction with a segwit marker', () => {
    expect(() => parseDogeTx(fromHex('0100000000010000000000'))).toThrow()
  })
})

describe('Dogecoin addresses', () => {
  it('receives on its own D… address, whose script is what it pays', () => {
    const pub = Uint8Array.from(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const address = dogeCoinAddress(pub)
    expect(address.startsWith('D')).toBe(true)
    expect(toHex(dogeOutputScript(address))).toBe(toHex(dogeCoinScript(pub)))
  })

  it('refuses addresses of other chains', () => {
    expect(() => dogeOutputScript('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toThrow()
    expect(() => dogeOutputScript('LVg2kJoFNg45Nbpy53h7Fe1wKyeXVRhMH9')).toThrow()
  })

  it('confirms coins at the depth the views count', () => {
    expect(DOGE_PROOF_RULES.depth).toBe(COIN_INFO.doge.confirmations)
  })
})
