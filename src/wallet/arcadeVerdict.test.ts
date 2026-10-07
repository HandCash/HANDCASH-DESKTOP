import { describe, expect, it, vi } from 'vitest'
import { Beef } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'
import {
  arcadeAskTimeoutMs,
  arcadeRoundVerdict,
  askArcadeDirectly,
  hasArcadeBroadcaster,
  withArcadeAnswer,
} from './arcadeVerdict'

const TXID = 'c'.repeat(64)
const ok = (name: string) => ({ name, status: 'success', txidResults: [{ txid: TXID, status: 'success' }] })

describe('arcadeRoundVerdict', () => {
  it('has a verdict when Arcade accepted or named a defect', () => {
    expect(arcadeRoundVerdict([ok('ArcadeBeef')], true)).toEqual({ kind: 'answered' })
    expect(
      arcadeRoundVerdict(
        [{ name: 'ArcadeBeef', status: 'error', txidResults: [{ status: 'error', doubleSpend: true }] }],
        true,
      ),
    ).toEqual({ kind: 'answered' })
  })

  it('names why a fallback settled the round without Arcade', () => {
    expect(arcadeRoundVerdict([ok('GorillaPoolArcBeef')], true)).toEqual({ kind: 'missing', reason: 'not-asked' })
    const timedOut = {
      name: 'ArcadeBeef',
      status: 'error',
      txidResults: [{ txid: TXID, status: 'error', serviceError: true, notes: [{ what: 'postBeefServiceTimeout' }] }],
    }
    expect(arcadeRoundVerdict([timedOut, ok('GorillaPoolArcBeef')], true)).toEqual({
      kind: 'missing',
      reason: 'timed-out',
    })
    const errored = { name: 'ArcadeBeef', status: 'error', txidResults: [{ txid: TXID, status: 'error', serviceError: true }] }
    expect(arcadeRoundVerdict([errored], true)).toEqual({ kind: 'missing', reason: 'service-error' })
  })

  it('asks nothing of a wallet without an Arcade broadcaster', () => {
    expect(arcadeRoundVerdict([ok('GorillaPoolArcBeef')], false)).toEqual({ kind: 'not-configured' })
  })
})

describe('askArcadeDirectly', () => {
  const servicesWith = (service: (beef: unknown, txids: string[]) => Promise<unknown>) =>
    ({ postBeefServices: { services: [{ name: 'Bitails', service: vi.fn() }, { name: 'ArcadeBeef', service }] } }) as unknown as Services

  it('returns Arcade’s own answer, named', async () => {
    const services = servicesWith(async () => ({ status: 'success', txidResults: [{ txid: TXID, status: 'success' }] }))
    expect(hasArcadeBroadcaster(services)).toBe(true)
    await expect(askArcadeDirectly(services, TXID, new Beef().toBinary())).resolves.toMatchObject({
      name: 'ArcadeBeef',
      status: 'success',
    })
  })

  it('turns a thrown post into a service error, not a verdict', async () => {
    const services = servicesWith(async () => {
      throw new Error('Failed to fetch')
    })
    const answer = await askArcadeDirectly(services, TXID, new Beef().toBinary())
    expect(answer?.txidResults?.[0]).toMatchObject({
      serviceError: true,
      notes: [{ what: 'arcadeDirectError', message: 'Failed to fetch' }],
    })
  })

  it('has no broadcaster to ask on a wallet without Arcade', async () => {
    const services = { postBeefServices: { services: [{ name: 'Bitails', service: vi.fn() }] } } as unknown as Services
    expect(hasArcadeBroadcaster(services)).toBe(false)
    await expect(askArcadeDirectly(services, TXID, [])).resolves.toBeNull()
  })
})

describe('helpers', () => {
  it('gives a large package the upload time a phone needs', () => {
    expect(arcadeAskTimeoutMs(10_000)).toBe(20_400)
    expect(arcadeAskTimeoutMs(2 * 1024 * 1024)).toBe(20_000 + 2048 * 40)
    expect(arcadeAskTimeoutMs(50 * 1024 * 1024)).toBe(180_000)
  })

  it('replaces the round’s Arcade entry with the direct answer', () => {
    const merged = withArcadeAnswer(
      [{ name: 'ArcadeBeef', status: 'error' }, ok('GorillaPoolArcBeef')],
      ok('ArcadeBeef'),
    )
    expect(merged.map((r) => [r.name, r.status])).toEqual([
      ['ArcadeBeef', 'success'],
      ['GorillaPoolArcBeef', 'success'],
    ])
  })
})
