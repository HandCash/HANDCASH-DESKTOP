import { describe, expect, it, vi } from 'vitest'
import { LockingScript, Transaction } from '@bsv/sdk'
import {
  GENESIS_PARENT_LATCH,
  LATCH_SCHEMA_VERSION,
  RELATIVE_TIP,
  buildLatchStateScript,
  findLatchStateForTip,
  parseLatchStateScript,
} from './oneSatLatch'

const ORIGIN = `${'a'.repeat(64)}_0`
const PARENT = `${'b'.repeat(64)}_1`

describe('BRC-156 on-chain latch state', () => {
  it('round-trips state a receiver needs to name the item', () => {
    const script = buildLatchStateScript({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: RELATIVE_TIP,
      parentLatch: PARENT,
      name: 'Test Item',
      app: 'handcash',
      mimeType: 'image/png',
    })

    expect(parseLatchStateScript(script)).toEqual({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: RELATIVE_TIP,
      parentLatch: PARENT,
      name: 'Test Item',
      app: 'handcash',
      mimeType: 'image/png',
    })
  })

  it('is provably unspendable so it never lands in an address scan', () => {
    const script = buildLatchStateScript({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: RELATIVE_TIP,
      parentLatch: GENESIS_PARENT_LATCH,
    })
    // OP_FALSE OP_RETURN
    expect(script.startsWith('006a')).toBe(true)
  })

  it('survives a real transaction serialize and parse', () => {
    // The receiver reads this back out of the settle tx, not out of local
    // metadata, so it has to survive the wire round trip.
    const script = buildLatchStateScript({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: RELATIVE_TIP,
      parentLatch: PARENT,
      name: 'Wire Item',
    })

    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(script) })

    const rebuilt = Transaction.fromHex(tx.toHex())
    const outputs = rebuilt.outputs.map((o) => ({ lockingScript: o.lockingScript?.toHex() }))

    expect(findLatchStateForTip(outputs, 0)).toMatchObject({
      origin: ORIGIN,
      name: 'Wire Item',
    })
  })

  it('will not hand one tip the identity meant for another', () => {
    const script = buildLatchStateScript({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: 'OUTPUT:0',
      parentLatch: PARENT,
      name: 'Item Zero',
    })
    const outputs = [{ lockingScript: script }]

    expect(findLatchStateForTip(outputs, 0)?.name).toBe('Item Zero')
    expect(findLatchStateForTip(outputs, 3)).toBeNull()
  })

  it('names a latched tip from the settle tx alone, with no indexer call', async () => {
    // The point of latching: the transfer carries its own identity, so a
    // receiver never waits on GorillaPool having indexed it.
    const state = buildLatchStateScript({
      schema: LATCH_SCHEMA_VERSION,
      origin: ORIGIN,
      tip: RELATIVE_TIP,
      parentLatch: PARENT,
      name: 'Latched Item',
      app: 'handcash',
    })
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({ satoshis: 2, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(state) })

    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/hex')) return new Response(tx.toHex())
      return new Response('null', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { resolveLatchedTip } = await import('./oneSatImport')
    const resolved = await resolveLatchedTip('e'.repeat(64), 0, 'main')

    expect(resolved).toMatchObject({ origin: ORIGIN, name: 'Latched Item', app: 'handcash' })
    expect(calls.every((u) => u.endsWith('/hex'))).toBe(true)
    expect(calls.some((u) => u.includes('gorillapool'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('ignores unrelated scripts and malformed payloads', () => {
    expect(parseLatchStateScript('76a914' + '11'.repeat(20) + '88ac')).toBeNull()
    expect(parseLatchStateScript('006a04deadbeef')).toBeNull()
    expect(parseLatchStateScript('')).toBeNull()
  })
})
