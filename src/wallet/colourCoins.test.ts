import { describe, expect, it } from 'vitest'
import {
  aggregateColourTokens,
  assertColourAmtConservation,
  buildColourCustomInstructions,
  buildOnesatFtOriginInscriptionJson,
  evaluateColourSupply,
  looksLikeOnesatFtTip,
  normalizeColourOrigin,
  originFromColourCi,
  parseColourTipAmt,
  parseOnesatFtOriginPolicy,
  selectColourTipsForAmount,
  verifyColourTipProvenance,
  type ColourTip,
} from './colourCoins'
import { buildOnesatFtMintLockingScript } from './onesatFtInscribe'

const ORIGIN = `${'ab'.repeat(32)}_0`

function tip(outpoint: string, opts: Partial<ColourTip> = {}): ColourTip {
  return {
    outpoint,
    origin: ORIGIN,
    satoshis: 1,
    amt: 1,
    proven: true,
    customInstructions: JSON.stringify({ p: '1sat-ft', origin: ORIGIN }),
    ...opts,
  }
}

describe('1Sat fungibles (BRC-175)', () => {
  it('normalizes dotted origin outpoints', () => {
    expect(normalizeColourOrigin(`${'ab'.repeat(32)}.0`)).toBe(ORIGIN)
  })

  it('builds origin inscription with optional lock', () => {
    const locked = buildOnesatFtOriginInscriptionJson({
      supply: 'locked',
      maxSupply: 10,
      sym: 'GOLD',
    })
    expect(locked.p).toBe('1sat-ft')
    expect(locked.supply).toBe('locked')
    expect(locked.max).toBe('10')
    expect(locked.amt).toBe('10')
    expect(locked.v).toBe(1)

    const uncapped = buildOnesatFtOriginInscriptionJson({
      amt: 1000,
      sym: 'PTS',
    })
    expect(uncapped.amt).toBe('1000')
    expect(uncapped.supply).toBeUndefined()
    expect(uncapped.max).toBeUndefined()
  })

  it('parses locked policy and tip amt from CI', () => {
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 100,
      amt: 40,
      sym: 'GOLD',
    })
    const meta = parseOnesatFtOriginPolicy(ORIGIN, { customInstructions: ci })
    expect(meta.supply).toBe('locked')
    expect(meta.maxSupply).toBe(100)
    expect(meta.sym).toBe('GOLD')
    expect(parseColourTipAmt({ customInstructions: ci })).toBe(40)
  })

  it('does not invent locked supply on remittance', () => {
    const ci = JSON.parse(
      buildColourCustomInstructions({
        origin: ORIGIN,
        amt: 25,
        sym: 'PTS',
      }),
    ) as Record<string, unknown>
    expect(ci.amt).toBe('25')
    expect(ci.supply).toBeUndefined()
    expect(ci.max).toBeUndefined()
  })

  it('defaults missing tip amt to 1', () => {
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 10,
    })
    expect(parseColourTipAmt({ customInstructions: ci })).toBe(1)
    expect(parseColourTipAmt({})).toBe(1)
  })

  it('accepts genesis tip without locked supply', () => {
    const { lockingScript } = buildOnesatFtMintLockingScript({
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      sym: 'PTS',
      amt: 1000,
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: ORIGIN,
      claimedOrigin: ORIGIN,
      provenance: null,
      lockingScriptHex: lockingScript,
    })
    expect(check.ok).toBe(true)
    expect(check.via).toBe('genesis')
    const meta = parseOnesatFtOriginPolicy(ORIGIN, {
      lockingScriptHex: lockingScript,
    })
    expect(meta.supply).toBe('open')
    expect(meta.maxSupply).toBeNull()
  })

  it('accepts genesis tip with locked max', () => {
    const { lockingScript } = buildOnesatFtMintLockingScript({
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      sym: 'GOLD',
      maxSupply: 5,
      supply: 'locked',
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: ORIGIN,
      claimedOrigin: ORIGIN,
      provenance: null,
      lockingScriptHex: lockingScript,
    })
    expect(check.ok).toBe(true)
    expect(check.via).toBe('genesis')
  })

  it('accepts same-tx mint batch when max is unit supply', () => {
    const meta = parseOnesatFtOriginPolicy(ORIGIN, {
      customInstructions: buildColourCustomInstructions({
        origin: ORIGIN,
        supply: 'locked',
        maxSupply: 1000,
        amt: 700,
        sym: 'GOLD',
      }),
    })
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 1000,
      amt: 300,
      mintBatchVout: 3,
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: `${'ab'.repeat(32)}_3`,
      claimedOrigin: ORIGIN,
      provenance: null,
      customInstructions: ci,
      originMeta: meta,
    })
    expect(check.ok).toBe(true)
    expect(check.via).toBe('mint-batch')
  })

  it('rejects mint batch when vout attestation mismatches tip', () => {
    const meta = {
      origin: ORIGIN,
      supply: 'locked' as const,
      maxSupply: 1000,
    }
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 1000,
      mintBatchVout: 5,
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: `${'ab'.repeat(32)}_3`,
      claimedOrigin: ORIGIN,
      provenance: null,
      customInstructions: ci,
      originMeta: meta,
    })
    expect(check.ok).toBe(false)
  })

  it('rejects mint.extend under interop v1', () => {
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 10,
      mintExtend: true,
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: `${'cd'.repeat(32)}_0`,
      claimedOrigin: ORIGIN,
      provenance: null,
      customInstructions: ci,
      originMeta: { origin: ORIGIN, supply: 'locked', maxSupply: 10 },
    })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/extend/i)
  })

  it('accepts remittance parent hop when parent is bound', () => {
    const tipOut = `${'cd'.repeat(32)}_0`
    const ci = buildColourCustomInstructions({
      origin: ORIGIN,
      supply: 'locked',
      maxSupply: 10,
      amt: 4,
      parent: `${'ab'.repeat(32)}_1`,
    })
    const check = verifyColourTipProvenance({
      tipOutpoint: tipOut,
      claimedOrigin: ORIGIN,
      provenance: null,
      customInstructions: ci,
      originMeta: { origin: ORIGIN, supply: 'locked', maxSupply: 10 },
      parentBound: true,
    })
    expect(check.ok).toBe(true)
    expect(check.via).toBe('parent')
  })

  it('fails closed when parent is attested but not proven (open or locked)', () => {
    const parent = `${'ab'.repeat(32)}_1`
    const tipOut = `${'cd'.repeat(32)}_0`
    for (const supply of ['open', 'locked'] as const) {
      const ci = buildColourCustomInstructions({
        origin: ORIGIN,
        supply,
        ...(supply === 'locked' ? { maxSupply: 10 } : {}),
        amt: 4,
        parent,
      })
      const meta = {
        origin: ORIGIN,
        supply,
        maxSupply: supply === 'locked' ? 10 : null,
      }
      expect(
        verifyColourTipProvenance({
          tipOutpoint: tipOut,
          claimedOrigin: ORIGIN,
          provenance: null,
          customInstructions: ci,
          originMeta: meta,
          parentBound: false,
        }).ok,
      ).toBe(false)
      expect(
        verifyColourTipProvenance({
          tipOutpoint: tipOut,
          claimedOrigin: ORIGIN,
          provenance: null,
          customInstructions: ci,
          originMeta: meta,
          // omitted parentBound — never soft-bind
        }).ok,
      ).toBe(false)
    }
  })

  it('aggregates balance as Σ amt (missing amt ⇒ 1)', () => {
    const tips = [
      tip(`${'11'.repeat(32)}_0`, { amt: 1000 }),
      tip(`${'cd'.repeat(32)}_0`, { amt: 1 }),
      tip(`${'ef'.repeat(32)}_0`, {
        proven: false,
        amt: 50,
        customInstructions: JSON.stringify({ name: 'Collectable' }),
      }),
    ]
    const meta = new Map([
      [
        ORIGIN,
        {
          origin: ORIGIN,
          supply: 'locked' as const,
          maxSupply: 2000,
          sym: 'GOLD',
        },
      ],
    ])
    const [row] = aggregateColourTokens(tips, meta)
    expect(row.tipCount).toBe(2)
    expect(row.balance).toBe(1001)
    expect(row.supply).toBe('locked')
    expect(row.sym).toBe('GOLD')
  })

  it('flags local over-cap on held units', () => {
    const evaled = evaluateColourSupply({
      meta: { origin: ORIGIN, supply: 'locked', maxSupply: 2 },
      heldUnits: 5,
    })
    expect(evaled.localExceedsCap).toBe(true)
  })

  it('selects tips by face value with change', () => {
    const tips = [
      tip(`${'11'.repeat(32)}_0`, { amt: 1000 }),
      tip(`${'22'.repeat(32)}_0`, { amt: 50 }),
    ]
    const cover = selectColourTipsForAmount(tips, 400)
    expect(cover.selected).toHaveLength(1)
    expect(cover.selected[0]!.amt).toBe(1000)
    expect(cover.selectedSum).toBe(1000)
    expect(cover.change).toBe(600)
    expect(cover.amount).toBe(400)
  })

  it('covers amount across multiple tips', () => {
    const tips = [
      tip(`${'11'.repeat(32)}_0`, { amt: 30 }),
      tip(`${'22'.repeat(32)}_0`, { amt: 40 }),
      tip(`${'33'.repeat(32)}_0`, { amt: 50 }),
    ]
    const cover = selectColourTipsForAmount(tips, 70)
    expect(cover.selectedSum).toBeGreaterThanOrEqual(70)
    expect(cover.change).toBe(cover.selectedSum - 70)
  })

  it('refuses when units are insufficient', () => {
    const tips = [tip(`${'11'.repeat(32)}_0`, { amt: 3 })]
    expect(() => selectColourTipsForAmount(tips, 4)).toThrow(/Need 4/)
  })

  it('enforces amt conservation', () => {
    expect(() => assertColourAmtConservation([1000], [400, 600])).not.toThrow()
    expect(() => assertColourAmtConservation([1000], [400, 500])).toThrow(
      /not conserved/,
    )
  })

  it('recognizes FT tips from CI or ord MIME, not tags alone', () => {
    expect(looksLikeOnesatFtTip({ tags: [] })).toBe(false)
    expect(looksLikeOnesatFtTip({ tags: ['1sat-ft', 'ordinal'] })).toBe(false)
    expect(
      looksLikeOnesatFtTip({
        tags: ['1sat-ft', 'ordinal'],
        customInstructions: JSON.stringify({ name: 'Pixel Foxes' }),
      }),
    ).toBe(false)
    expect(
      looksLikeOnesatFtTip({
        customInstructions: JSON.stringify({
          p: '1sat-ft',
          amt: '69420',
          sym: 'KING',
        }),
      }),
    ).toBe(true)
    const { lockingScript } = buildOnesatFtMintLockingScript({
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      sym: 'KING',
      amt: 69420,
      supply: 'locked',
      maxSupply: 69420,
    })
    expect(looksLikeOnesatFtTip({ lockingScriptHex: lockingScript })).toBe(true)
  })

  it('counts leftover after send, not the spent mint', () => {
    const mint = tip(ORIGIN, { amt: 69420 })
    const change = tip(`${'cd'.repeat(32)}_1`, { amt: 69000 })
    const rows = aggregateColourTokens(
      [mint, change],
      new Map([
        [ORIGIN, { origin: ORIGIN, supply: 'locked', maxSupply: 69420, sym: 'KING' }],
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.balance).toBe(69000)
    expect(rows[0]!.outpoint).toBe(change.outpoint)
  })

  it('counts a leftover tip even when the spent mint is gone from the list', () => {
    const change = tip(`${'cd'.repeat(32)}_1`, { amt: 69000 })
    const rows = aggregateColourTokens(
      [change],
      new Map([
        [ORIGIN, { origin: ORIGIN, supply: 'locked', maxSupply: 69420, sym: 'KING' }],
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.balance).toBe(69000)
  })

  it('still sums a same-tx mint batch', () => {
    const genesis = tip(ORIGIN, { amt: 500 })
    const sibling = tip(`${ORIGIN.split('_')[0]}_1`, { amt: 500 })
    const rows = aggregateColourTokens(
      [genesis, sibling],
      new Map([
        [ORIGIN, { origin: ORIGIN, supply: 'locked', maxSupply: 1000, sym: 'BATCH' }],
      ]),
    )
    expect(rows[0]!.balance).toBe(1000)
    expect(rows[0]!.tipCount).toBe(2)
  })

  it('ignores collectable JSON that has no 1sat-ft protocol', () => {
    const meta = parseOnesatFtOriginPolicy(ORIGIN, {
      customInstructions: JSON.stringify({
        name: 'Pixel Foxes',
        amt: 1,
      }),
    })
    expect(meta.sym).toBeUndefined()
    expect(meta.name).toBeUndefined()
    expect(meta.supply).toBe('open')
    expect(meta.maxSupply).toBeNull()
  })

  it('resolves iconVout on genesis to same-tx icon outpoint', () => {
    const meta = parseOnesatFtOriginPolicy(ORIGIN, {
      customInstructions: JSON.stringify({
        p: '1sat-ft',
        amt: '100',
        sym: 'KING',
        iconVout: 1,
      }),
    })
    expect(meta.icon).toBe(`${'ab'.repeat(32)}_1`)
    expect(meta.sym).toBe('KING')
  })

  it('overlays CI iconVout when ord envelope already supplied policy', () => {
    const { lockingScript } = buildOnesatFtMintLockingScript({
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      sym: 'KING',
      amt: 69420,
      supply: 'locked',
      maxSupply: 69420,
    })
    const meta = parseOnesatFtOriginPolicy(ORIGIN, {
      lockingScriptHex: lockingScript,
      customInstructions: JSON.stringify({
        p: '1sat-ft',
        amt: '69420',
        sym: 'KING',
        iconVout: 1,
      }),
    })
    expect(meta.supply).toBe('locked')
    expect(meta.maxSupply).toBe(69420)
    expect(meta.sym).toBe('KING')
    expect(meta.icon).toBe(`${'ab'.repeat(32)}_1`)
  })
  it('reads mint origin from remittance CI, not the receive outpoint', () => {
    const mint = '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
    const receive = '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19_0'
    expect(
      originFromColourCi(
        JSON.stringify({ p: '1sat-ft', origin: mint, amt: '69', name: 'sixtyniine' }),
      ),
    ).toBe(mint)
    expect(originFromColourCi(JSON.stringify({ p: '1sat-ft', amt: '69' }))).toBeNull()
    const change = tip(
      '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19_1',
      { amt: 68931, origin: mint },
    )
    const recv = tip(receive, { amt: 69, origin: mint })
    const rows = aggregateColourTokens(
      [change, recv],
      new Map([[mint, { origin: mint, supply: 'locked', maxSupply: 69420, sym: 'KING' }]]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.origin).toBe(mint)
    expect(rows[0]!.balance).toBe(69000)
    expect(rows[0]!.sym).toBe('KING')
  })

})
