import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const ORIGIN = `${'ab'.repeat(32)}_0`
const CHANGE = `${'cd'.repeat(32)}_1`
const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
const SPENT_CHANGE =
  '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19_1'
const LIVE_CHANGE = `46fe5d93${'aa'.repeat(28)}_1`
const RECEIVE_A = `11${'bb'.repeat(31)}_0`
const LEGACY = '9abe8bdb97f608b05ccf920768cea178315072d665027636a00fac38e0bb9c90_1'

function kingCi(amt: number) {
  return JSON.stringify({
    p: '1sat-ft',
    origin: KING_ORIGIN,
    amt: String(amt),
    sym: 'KING',
    supply: 'locked',
    max: '69420',
  })
}

describe('onesatFtLeftover', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('remembers leftover remittance keyed by outpoint', async () => {
    const { rememberOnesatFtLeftover, leftoverForOutpoint, listOnesatFtLeftovers } =
      await import('./onesatFtLeftover')
    rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 68862,
      outpoint: CHANGE,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const row = leftoverForOutpoint(CHANGE.replace('_1', '.1'))
    expect(row?.amt).toBe(68862)
    expect(row?.outpoint).toBe(CHANGE)
    expect(row?.origin).toBe(ORIGIN)
    expect(JSON.parse(row!.ci).p).toBe('1sat-ft')
    expect(listOnesatFtLeftovers()).toHaveLength(1)
  })

  it('forgets leftover remittance on a full burn (remaining 0)', async () => {
    const {
      rememberOnesatFtLeftover,
      forgetOnesatFtLeftover,
      listOnesatFtLeftovers,
      leftoverForOutpoint,
      isOnesatFtGenesisSpent,
    } = await import('./onesatFtLeftover')
    rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 68862,
      outpoint: CHANGE,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    forgetOnesatFtLeftover(ORIGIN)
    expect(listOnesatFtLeftovers()).toHaveLength(0)
    expect(leftoverForOutpoint(CHANGE)).toBeNull()
    expect(isOnesatFtGenesisSpent(ORIGIN)).toBe(true)
  })

  it('marks spent genesis forever (does not expire)', async () => {
    const { markOnesatFtGenesisSpent, isOnesatFtGenesisSpent } = await import(
      './onesatFtLeftover'
    )
    markOnesatFtGenesisSpent(ORIGIN)
    expect(isOnesatFtGenesisSpent(ORIGIN)).toBe(true)
    expect(isOnesatFtGenesisSpent(ORIGIN.replace('_0', '.0'))).toBe(true)
  })

  it('never re-seeds hardcoded leftover outpoints', async () => {
    const leftover = await import('./onesatFtLeftover')
    const miss = leftover.healOnesatFtFromListed([])
    expect(miss.seededLeftover).toBe(false)
    expect(leftover.listOnesatFtLeftovers()).toHaveLength(0)
    expect(leftover.leftoverForOutpoint(LEGACY)).toBeNull()
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)).toBeNull()
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)).toBeNull()
  })

  it('drops leftover when that outpoint is sent', async () => {
    const { markItemsSent } = await import('./sentItemGuard')
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68931,
      outpoint: SPENT_CHANGE,
      ci: kingCi(68931),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)?.amt).toBe(68931)
    markItemsSent([SPENT_CHANGE])
    const result = leftover.healOnesatFtFromListed([])
    expect(result.forgotten).toContain(SPENT_CHANGE)
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)).toBeNull()
    expect(leftover.getOnesatFtLeftover(KING_ORIGIN)).toBeNull()
  })

  it('keeps send remittance leftover 46fe5d93_1 68862 and forgets spent 2a562450_1', async () => {
    const { markItemsSent } = await import('./sentItemGuard')
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68931,
      outpoint: SPENT_CHANGE,
      ci: kingCi(68931),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    markItemsSent([SPENT_CHANGE])
    leftover.healOnesatFtFromListed([])
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)).toBeNull()
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)?.amt).toBe(68862)
    leftover.healOnesatFtFromListed([])
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)?.amt).toBe(68862)
    expect(leftover.leftoverForOutpoint(LEGACY)).toBeNull()
  })

  it('overlays leftover change even when a receive of the same origin is listed', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const row = leftover.leftoverForOutpoint(LIVE_CHANGE)!
    expect(
      leftover.shouldOverlayOnesatFtLeftover(row, [RECEIVE_A.replace('_0', '.0')]),
    ).toBe(true)
    expect(
      leftover.shouldOverlayOnesatFtLeftover(row, [LIVE_CHANGE.replace('_1', '.1')]),
    ).toBe(false)
  })

  it('does not remember leftover whose outpoint is already sent', async () => {
    const { markItemsSent } = await import('./sentItemGuard')
    const leftover = await import('./onesatFtLeftover')
    markItemsSent([SPENT_CHANGE])
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68931,
      outpoint: SPENT_CHANGE,
      ci: kingCi(68931),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)).toBeNull()
  })

  it('refuses to remember leftover amt over the origin cap', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 206724,
      outpoint: LIVE_CHANGE,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)).toBeNull()
  })

  it('migrates origin-keyed store to outpoint keys', async () => {
    store.set(
      'handcash.onesat-ft.leftover.v1',
      JSON.stringify({
        items: {
          [KING_ORIGIN]: {
            origin: KING_ORIGIN,
            amt: 68862,
            outpoint: LIVE_CHANGE,
            ci: kingCi(68862),
            sym: 'KING',
            supply: 'locked',
            maxSupply: 69420,
            at: 1,
          },
        },
      }),
    )
    const leftover = await import('./onesatFtLeftover')
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)?.amt).toBe(68862)
    expect(leftover.getOnesatFtLeftover(KING_ORIGIN)?.outpoint).toBe(LIVE_CHANGE)
  })

  it('marks leftover origin and change as collectable misfiles', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69,
      outpoint: CHANGE,
      ci: JSON.stringify({ p: '1sat-ft', origin: ORIGIN, amt: '69' }),
      sym: 'OLD',
      supply: 'locked',
      maxSupply: 100,
    })
    expect(leftover.isOnesatFtCollectableMisfile(ORIGIN)).toBe(true)
    expect(leftover.isOnesatFtCollectableMisfile(CHANGE)).toBe(true)
    expect(leftover.isOnesatFtCollectableMisfile(`${'11'.repeat(32)}_0`)).toBe(false)
  })
})
