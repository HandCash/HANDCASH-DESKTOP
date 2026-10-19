import { describe, expect, it } from 'vitest'
import type { LtcCheckpoint } from '../ltc/checkpoint'
import { createHeaderChain, memoryLtcHeaderStore, type HeaderSource } from '../ltc/headers'
import { fromHex, parseLtcHeader } from '../ltc/litecoin'
import { checkLtcBurial } from '../ltc/verify'
import { bchCoinScript } from './bitcoincash'
import { BCH_PROOF_RULES } from './bchWallet'
import fixture from './fixtures/chain.json'
import { BCH_CHECKPOINT, BCH_HEADER_RULES } from './headers'

const START = fixture.recent.start
const raws = Array.from({ length: fixture.recent.hex.length / 160 }, (_, i) => fromHex(fixture.recent.hex.slice(i * 160, i * 160 + 160)))
const parsed = raws.map(parseLtcHeader)
const LAST = START + raws.length - 1
const NOW = (parsed[parsed.length - 1]!.time + 600) * 1000
const at = (height: number) => parsed[height - START]!
const checkpointAt = (height: number): LtcCheckpoint => ({ height, hash: at(height).hash, bits: at(height).bits, time: at(height).time, windowEnds: {} })

function sourceOf(over: { tip?: number; edit?: (height: number, raw: Uint8Array) => Uint8Array; calls?: string[] } = {}): HeaderSource {
  const serve = (height: number) => (over.edit ? over.edit(height, raws[height - START]!) : raws[height - START]!)
  return {
    tipHeight: async () => over.tip ?? LAST,
    headerPage: async () => {
      throw new Error('ranges only')
    },
    headerRange: async (lo, hi) => {
      over.calls?.push(`${lo}-${hi}`)
      return Array.from({ length: hi - lo + 1 }, (_, i) => serve(lo + i))
    },
  }
}

const chainOf = (source: HeaderSource, checkpoint = checkpointAt(START), now = NOW) =>
  createHeaderChain({ rules: BCH_HEADER_RULES, source, checkpoint, store: memoryLtcHeaderStore(), now: () => now })

const withByte = (raw: Uint8Array, index: number, value: number) => {
  const out = Uint8Array.from(raw)
  out[index] = value
  return out
}

describe('Bitcoin Cash header chain', () => {
  it('ships a checkpoint that is the real block at its height', () => {
    expect(at(BCH_CHECKPOINT.height)).toMatchObject({ hash: BCH_CHECKPOINT.hash, bits: BCH_CHECKPOINT.bits, time: BCH_CHECKPOINT.time })
  })

  it('syncs every real block under ASERT and double SHA-256, in ranges', async () => {
    const calls: string[] = []
    const chain = chainOf(sourceOf({ calls }))
    expect(await chain.check(fixture.tx.height, at(fixture.tx.height).hash, 6)).toEqual({ kind: 'buried' })
    expect(await chain.tipHeight()).toBe(LAST)
    expect(calls.length).toBeLessThan(10)
  })

  it('takes no header whose bits are not what ASERT gives it', async () => {
    const chain = chainOf(sourceOf({ edit: (h, raw) => (h === START + 5 ? withByte(raw, 72, raw[72]! ^ 1) : raw) }))
    expect(await chain.check(START + 3, at(START + 3).hash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/Bitcoin Cash header \d+ refused: bits/) })
  })

  it('takes no header without its proof of work', async () => {
    const chain = chainOf(sourceOf({ edit: (h, raw) => (h === START + 2 ? withByte(raw, 76, raw[76]! ^ 1) : raw) }))
    expect(await chain.check(START + 1, at(START + 1).hash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/pow/) })
  })

  it('cannot judge bits without its parent time, and says so', async () => {
    const chain = chainOf(sourceOf(), { ...checkpointAt(START), time: undefined as unknown as number })
    expect(await chain.check(START + 1, at(START + 1).hash, 6)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/no-window/) })
  })
})

describe('Bitcoin Cash burial', () => {
  const proof = {
    tx: fixture.tx.raw,
    path: fixture.tx.merkle,
    pos: fixture.tx.pos,
    height: fixture.tx.height,
    header: fixture.recent.hex.slice((fixture.tx.height - START) * 160, (fixture.tx.height - START + 1) * 160),
  }
  const outpoint = { txid: fixture.tx.txid, vout: 0 }

  it('refuses a real transaction for a script it does not pay, after parsing it as Bitcoin Cash', async () => {
    const check = await checkLtcBurial(proof, outpoint, bchCoinScript(new Uint8Array(33).fill(2)), 0n, chainOf(sourceOf()), BCH_PROOF_RULES)
    expect(check).toMatchObject({ ok: false, reason: 'wrong-script' })
  })

  it('counts a real coin buried on its own chain, and refuses it while shallow or reorganized away', async () => {
    const { parseBchTx } = await import('./bitcoincash')
    const script = parseBchTx(fromHex(fixture.tx.raw)).outputs[0]!.script
    const buried = await checkLtcBurial(proof, outpoint, script, 0n, chainOf(sourceOf()), BCH_PROOF_RULES)
    expect(buried.ok).toBe(true)
    const shallow = await checkLtcBurial(proof, outpoint, script, 0n, chainOf(sourceOf({ tip: fixture.tx.height + 2 })), BCH_PROOF_RULES)
    expect(shallow).toMatchObject({ ok: false, reason: 'shallow', confirmations: 3, detail: expect.stringMatching(/Bitcoin Cash chain/) })
    const forged = await checkLtcBurial({ ...proof, path: [...proof.path.slice(1), proof.path[0]!] }, outpoint, script, 0n, chainOf(sourceOf()), BCH_PROOF_RULES)
    expect(forged).toMatchObject({ ok: false, reason: 'merkle' })
  })
})
