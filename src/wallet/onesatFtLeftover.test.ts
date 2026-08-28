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
})
