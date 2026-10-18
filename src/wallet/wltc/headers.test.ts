import { describe, expect, it } from 'vitest'
import type { LtcChain } from './chain'
import type { LtcCheckpoint } from './checkpoint'
import fixture from './fixtures/deposit.json'
import { compactFromTarget, createLtcHeaderChain, memoryLtcHeaderStore, nextLtcBits, type LtcHeaderStore } from './headers'
import { fromHex, parseLtcHeader, targetFromBits } from './litecoin'

const parsed = fixture.headers.map((h) => parseLtcHeader(fromHex(h)))
const LAST = fixture.height + fixture.headers.length - 1
const NOW = (parsed[parsed.length - 1]!.time + 600) * 1000
const BEFORE: LtcCheckpoint = { height: fixture.height - 1, hash: parsed[0]!.prevHash, bits: parsed[0]!.bits, time: parsed[0]!.time - 150, windowEnds: {} }

/** An explorer over the fixture's twelve real consecutive blocks; `edit` swaps the bytes it serves for one height. */
function sourceOf(over: { tip?: number; edit?: (height: number, raw: Uint8Array) => Uint8Array; calls?: string[] } = {}): LtcChain {
  return {
    tipHeight: async () => {
      over.calls?.push('tip')
      return over.tip ?? LAST
    },
    headerPage: async (top: number) => {
      over.calls?.push(`page ${top}`)
      return fixture.headers
        .map((h, i) => ({ height: fixture.height + i, header: over.edit ? over.edit(fixture.height + i, fromHex(h)) : fromHex(h) }))
        .filter((r) => r.height <= top && r.height > top - 10)
    },
  } as unknown as LtcChain
}

const chainOf = (source: LtcChain, checkpoint = BEFORE, store: LtcHeaderStore = memoryLtcHeaderStore(), now = NOW) =>
  createLtcHeaderChain({ source, checkpoint, store, now: () => now })

const withByte = (raw: Uint8Array, at: number, value: number) => {
  const out = Uint8Array.from(raw)
  out[at] = value
  return out
}

describe('Litecoin retarget', () => {
  it('reproduces the real retarget at block 3195360 from the window ends 3195359 and 3193343', () => {
    expect(nextLtcBits(422634139, 1792058721, 1791740629)).toBe(422800385)
  })

  it('encodes targets back to the compact bits they came from', () => {
    for (const bits of [422800385, 422634139, 422364288, 0x1e0fffff, 0x1d00ffff]) expect(compactFromTarget(targetFromBits(bits)!)).toBe(bits)
  })
})

describe('Litecoin header chain', () => {
  it('syncs from its checkpoint and holds a block six deep', async () => {
    const chain = chainOf(sourceOf())
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toEqual({ kind: 'buried' })
    expect(await chain.tipHeight()).toBe(LAST)
  })

  it('reports a block the chain holds but not deep enough yet', async () => {
    const chain = chainOf(sourceOf({ tip: fixture.height + 3 }))
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toEqual({ kind: 'shallow', confirmations: 4 })
    expect(await chain.check(fixture.height + 7, parsed[7]!.hash, 6)).toEqual({ kind: 'shallow', confirmations: 0 })
  })

  it('refuses a block the chain holds another block at', async () => {
    const chain = chainOf(sourceOf())
    expect(await chain.check(fixture.height, 'ab'.repeat(32), 6)).toEqual({ kind: 'off-chain' })
  })

  it('takes no header without the proof of work its bits demand', async () => {
    const chain = chainOf(sourceOf({ edit: (h, raw) => (h === fixture.height + 2 ? withByte(raw, 76, raw[76]! ^ 1) : raw) }))
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/pow/) })
  })

  it('takes no header whose bits differ from the block before inside a retarget window', async () => {
    const chain = chainOf(sourceOf({ edit: (h, raw) => (h === fixture.height + 1 ? withByte(raw, 72, raw[72]! ^ 1) : raw) }))
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/bits/) })
  })

  it('takes no header from more than two hours in the future', async () => {
    const chain = chainOf(sourceOf(), BEFORE, memoryLtcHeaderStore(), parsed[0]!.time * 1000 - 3 * 3600_000)
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/future/) })
  })

  it('takes no chain that does not start at its checkpoint', async () => {
    const chain = chainOf(sourceOf(), { ...BEFORE, hash: 'cd'.repeat(32) })
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toMatchObject({ kind: 'unavailable' })
  })

  it('links a block before its checkpoint down by hash alone', async () => {
    const at = fixture.height + 6
    const chain = chainOf(sourceOf({ tip: at }), { height: at, hash: parsed[6]!.hash, bits: parsed[6]!.bits, time: parsed[6]!.time, windowEnds: {} })
    expect(await chain.check(fixture.height, fixture.blockHash, 6)).toEqual({ kind: 'buried' })
    const lying = chainOf(
      sourceOf({ tip: at, edit: (h, raw) => (h === fixture.height + 3 ? withByte(raw, 4, raw[4]! ^ 1) : raw) }),
      { height: at, hash: parsed[6]!.hash, bits: parsed[6]!.bits, time: parsed[6]!.time, windowEnds: {} },
    )
    expect(await lying.check(fixture.height, fixture.blockHash, 6)).toMatchObject({ kind: 'unavailable' })
  })

  it('answers from the saved chain without the network once a block is deep', async () => {
    const store = memoryLtcHeaderStore()
    await chainOf(sourceOf(), BEFORE, store).check(fixture.height, fixture.blockHash, 6)
    const calls: string[] = []
    const reopened = chainOf(sourceOf({ calls }), BEFORE, store)
    expect(await reopened.check(fixture.height, fixture.blockHash, 6)).toEqual({ kind: 'buried' })
    expect(calls).toEqual([])
  })

  it('starts over from a newer shipped checkpoint', async () => {
    const store = memoryLtcHeaderStore()
    await chainOf(sourceOf({ tip: fixture.height + 2 }), BEFORE, store).sync()
    const at = fixture.height + 4
    const next = chainOf(sourceOf(), { height: at, hash: parsed[4]!.hash, bits: parsed[4]!.bits, time: parsed[4]!.time, windowEnds: {} }, store)
    expect(await next.tipHeight()).toBe(at)
    expect(await next.check(fixture.height + 5, parsed[5]!.hash, 6)).toEqual({ kind: 'buried' })
  })
})
