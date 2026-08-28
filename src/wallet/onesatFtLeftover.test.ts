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

describe('onesatFtLeftover', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('remembers leftover remittance and forgets a spent-down origin', async () => {
    const { rememberOnesatFtLeftover, listOnesatFtLeftovers, forgetOnesatFtLeftover } =
      await import('./onesatFtLeftover')
    rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69000,
      outpoint: `${'cd'.repeat(32)}_1`,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const rows = listOnesatFtLeftovers()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amt).toBe(69000)
    expect(rows[0]!.origin).toBe(ORIGIN)
    expect(JSON.parse(rows[0]!.ci).p).toBe('1sat-ft')
    forgetOnesatFtLeftover(ORIGIN)
    expect(listOnesatFtLeftovers()).toHaveLength(0)
  })

  it('forgets leftover remittance on a full burn (remaining 0)', async () => {
    const {
      rememberOnesatFtLeftover,
      forgetOnesatFtLeftover,
      listOnesatFtLeftovers,
      isOnesatFtGenesisSpent,
    } = await import('./onesatFtLeftover')
    rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69000,
      outpoint: `${'cd'.repeat(32)}_1`,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    forgetOnesatFtLeftover(ORIGIN)
    expect(listOnesatFtLeftovers()).toHaveLength(0)
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

  it('seeds KING leftover remittance even when listOutputs dropped the tip', async () => {
    const {
      healOnesatFtFromListed,
      getOnesatFtLeftover,
      isOnesatFtGenesisSpent,
      KING_ORIGIN,
      KING_LEFTOVER_OUTPOINT,
      BURNED_ONESAT_FT_ORIGINS,
    } = await import('./onesatFtLeftover')

    const miss = healOnesatFtFromListed([])
    expect(miss.seededLeftover).toBe(true)
    expect(getOnesatFtLeftover(KING_ORIGIN)?.amt).toBe(69000)
    expect(isOnesatFtGenesisSpent(KING_ORIGIN)).toBe(true)
    for (const burned of BURNED_ONESAT_FT_ORIGINS) {
      expect(isOnesatFtGenesisSpent(burned)).toBe(true)
    }

    const hit = healOnesatFtFromListed([
      { outpoint: KING_LEFTOVER_OUTPOINT.replace('_1', '.1'), satoshis: 1 },
    ])
    expect(hit.seededLeftover).toBe(true)
    const leftover = getOnesatFtLeftover(KING_ORIGIN)
    expect(leftover?.amt).toBe(69000)
    expect(leftover?.outpoint).toBe(KING_LEFTOVER_OUTPOINT)
    expect(JSON.parse(leftover!.ci)).toMatchObject({
      p: '1sat-ft',
      origin: KING_ORIGIN,
      amt: '69000',
      sym: 'KING',
      supply: 'locked',
      max: '69420',
    })
  })

  it('forgets leftover remittance for the two burned KING origins', async () => {
    const {
      rememberOnesatFtLeftover,
      healOnesatFtFromListed,
      getOnesatFtLeftover,
      BURNED_ONESAT_FT_ORIGINS,
    } = await import('./onesatFtLeftover')
    const burned = BURNED_ONESAT_FT_ORIGINS[0]!
    rememberOnesatFtLeftover({
      origin: burned,
      amt: 69420,
      outpoint: burned,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const result = healOnesatFtFromListed([])
    expect(result.forgotten).toContain(burned)
    expect(getOnesatFtLeftover(burned)).toBeNull()
  })

  it('does not reset leftover to 69000 after 2a562450 change is remembered', async () => {
    const {
      rememberOnesatFtLeftover,
      healOnesatFtFromListed,
      getOnesatFtLeftover,
      KING_ORIGIN,
      KING_CHANGE_OUTPOINT,
      KING_CHANGE_AMT,
      KING_LEFTOVER_OUTPOINT,
    } = await import('./onesatFtLeftover')
    rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: KING_CHANGE_AMT,
      outpoint: KING_CHANGE_OUTPOINT,
      ci: JSON.stringify({
        p: '1sat-ft',
        origin: KING_ORIGIN,
        amt: String(KING_CHANGE_AMT),
        sym: 'KING',
        supply: 'locked',
        max: '69420',
      }),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const result = healOnesatFtFromListed([])
    expect(result.seededLeftover).toBe(false)
    const leftover = getOnesatFtLeftover(KING_ORIGIN)
    expect(leftover?.amt).toBe(68931)
    expect(leftover?.outpoint).toBe(KING_CHANGE_OUTPOINT)
    expect(leftover?.outpoint).not.toBe(KING_LEFTOVER_OUTPOINT)
  })

  it('seeds 2a562450 change leftover when 9abe8bdb is sent', async () => {
    const { markItemsSent } = await import('./sentItemGuard')
    const {
      healOnesatFtFromListed,
      getOnesatFtLeftover,
      KING_ORIGIN,
      KING_CHANGE_OUTPOINT,
      KING_LEFTOVER_OUTPOINT,
    } = await import('./onesatFtLeftover')
    markItemsSent([KING_LEFTOVER_OUTPOINT])
    const result = healOnesatFtFromListed([])
    expect(result.seededLeftover).toBe(true)
    const leftover = getOnesatFtLeftover(KING_ORIGIN)
    expect(leftover?.amt).toBe(68931)
    expect(leftover?.outpoint).toBe(KING_CHANGE_OUTPOINT)
  })

  it('does not seed receive 69 as leftover when listOutputs already has it', async () => {
    const {
      healOnesatFtFromListed,
      getOnesatFtLeftover,
      KING_ORIGIN,
      KING_RECEIVE_OUTPOINT,
      KING_CHANGE_OUTPOINT,
      KING_LEFTOVER_OUTPOINT,
    } = await import('./onesatFtLeftover')
    const result = healOnesatFtFromListed([
      { outpoint: KING_RECEIVE_OUTPOINT.replace('_0', '.0'), satoshis: 1 },
    ])
    expect(result.seededLeftover).toBe(true)
    const leftover = getOnesatFtLeftover(KING_ORIGIN)
    expect(leftover?.outpoint).toBe(KING_CHANGE_OUTPOINT)
    expect(leftover?.amt).toBe(68931)
    expect(leftover?.outpoint).not.toBe(KING_RECEIVE_OUTPOINT)
    expect(leftover?.outpoint).not.toBe(KING_LEFTOVER_OUTPOINT)
  })

  it('does not re-seed 69000 on 9abe8bdb after that tip is sent', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(leftover.KING_LEFTOVER_OUTPOINT)
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: leftover.KING_CHANGE_AMT,
      outpoint: leftover.KING_CHANGE_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: 69000,
      outpoint: leftover.KING_LEFTOVER_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const result = leftover.healOnesatFtFromListed([])
    expect(result.seededLeftover).toBe(false)
    const row = leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)
    expect(row?.amt).toBe(68931)
    expect(row?.outpoint).toBe(leftover.KING_CHANGE_OUTPOINT)
    expect(leftover.isOnesatFtGenesisSpent(leftover.KING_LEFTOVER_OUTPOINT)).toBe(true)
  })

  it('does not remember receive 69 as leftover', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: 69,
      outpoint: leftover.KING_RECEIVE_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    expect(leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)).toBeNull()
  })

  it('overlays leftover outpoint once and skips spent 9abe8bdb beside 2a562450', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(leftover.KING_LEFTOVER_OUTPOINT)
    expect(
      leftover.shouldOverlayOnesatFtLeftover(
        { origin: leftover.KING_ORIGIN, outpoint: leftover.KING_LEFTOVER_OUTPOINT },
        [leftover.KING_RECEIVE_OUTPOINT.replace('_0', '.0'), leftover.KING_CHANGE_OUTPOINT],
      ),
    ).toBe(false)
    expect(
      leftover.shouldOverlayOnesatFtLeftover(
        { origin: leftover.KING_ORIGIN, outpoint: leftover.KING_RECEIVE_OUTPOINT },
        [leftover.KING_RECEIVE_OUTPOINT],
      ),
    ).toBe(false)
    expect(
      leftover.shouldOverlayOnesatFtLeftover(
        { origin: leftover.KING_ORIGIN, outpoint: leftover.KING_CHANGE_OUTPOINT },
        [leftover.KING_RECEIVE_OUTPOINT.replace('_0', '.0')],
      ),
    ).toBe(true)
    expect(
      leftover.shouldOverlayOnesatFtLeftover(
        { origin: leftover.KING_ORIGIN, outpoint: leftover.KING_CHANGE_OUTPOINT },
        [leftover.KING_CHANGE_OUTPOINT.replace('_1', '.1')],
      ),
    ).toBe(false)
  })

  it('wipes leftover amt over 69420 and reseeds KING change 68931', async () => {
    const leftover = await import('./onesatFtLeftover')
    store.set(
      'handcash.onesat-ft.leftover.v1',
      JSON.stringify({
        items: {
          [leftover.KING_ORIGIN]: {
            origin: leftover.KING_ORIGIN,
            amt: 206724,
            outpoint: leftover.KING_CHANGE_OUTPOINT,
            ci: JSON.stringify({
              p: '1sat-ft',
              origin: leftover.KING_ORIGIN,
              amt: '206724',
              sym: 'KING',
              supply: 'locked',
              max: '69420',
            }),
            sym: 'KING',
            supply: 'locked',
            maxSupply: leftover.KING_MAX_SUPPLY,
            at: 1,
          },
        },
      }),
    )
    const result = leftover.healOnesatFtFromListed([])
    expect(result.seededLeftover).toBe(true)
    const row = leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)
    expect(row?.amt).toBe(68931)
    expect(row?.outpoint).toBe(leftover.KING_CHANGE_OUTPOINT)
    expect(JSON.parse(row!.ci).amt).toBe('68931')
  })

  it('replaces leftover 9abe8bdb with change 68931 when receive 69 is listed', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: 69000,
      outpoint: leftover.KING_LEFTOVER_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: leftover.KING_MAX_SUPPLY,
    })
    const result = leftover.healOnesatFtFromListed([
      { outpoint: leftover.KING_RECEIVE_OUTPOINT.replace('_0', '.0') },
    ])
    expect(result.seededLeftover).toBe(true)
    const row = leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)
    expect(row?.outpoint).toBe(leftover.KING_CHANGE_OUTPOINT)
    expect(row?.amt).toBe(leftover.KING_CHANGE_AMT)
    expect(row?.outpoint).not.toBe(leftover.KING_LEFTOVER_OUTPOINT)
    expect(row?.outpoint).not.toBe(leftover.KING_RECEIVE_OUTPOINT)
  })

  it('does not overlay leftover when that outpoint is already listed', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: leftover.KING_CHANGE_AMT,
      outpoint: leftover.KING_CHANGE_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: leftover.KING_MAX_SUPPLY,
    })
    const row = leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)!
    expect(
      leftover.shouldOverlayOnesatFtLeftover(row, [
        leftover.KING_CHANGE_OUTPOINT.replace('_1', '.1'),
        leftover.KING_RECEIVE_OUTPOINT,
      ]),
    ).toBe(false)
  })

  it('refuses to remember leftover amt over the origin cap', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: leftover.KING_ORIGIN,
      amt: 206724,
      outpoint: leftover.KING_CHANGE_OUTPOINT,
      ci: '',
      sym: 'KING',
      supply: 'locked',
      maxSupply: leftover.KING_MAX_SUPPLY,
    })
    expect(leftover.getOnesatFtLeftover(leftover.KING_ORIGIN)).toBeNull()
  })
})
