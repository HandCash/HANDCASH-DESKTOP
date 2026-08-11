import { describe, expect, it } from 'vitest'
import {
  aggregateFungibles,
  buildBsv21CustomInstructions,
  formatFungibleAmount,
  isBsv21Mime,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  parseBsv21Json,
  bsv21Tags,
  tokenIdForListedTip,
  tokenIdForPayload,
  tokenIdFromBsv21Tags,
} from './bsv21'

describe('bsv21 parse', () => {
  const MNEE = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0'

  it('accepts deploy+mint and resolves id from the tip outpoint', () => {
    const payload = parseBsv21Json({
      p: 'bsv-20',
      op: 'deploy+mint',
      amt: '1000',
      sym: 'GOLD',
      dec: '2',
    })
    expect(payload).toMatchObject({ op: 'deploy+mint', amt: '1000', sym: 'GOLD', dec: 2 })
    expect(tokenIdForPayload(payload!, `${'ab'.repeat(32)}_0`)).toBe(`${'ab'.repeat(32)}_0`)
  })

  it('accepts transfer with id + amt', () => {
    const payload = parseBsv21Json({
      p: 'bsv-20',
      op: 'transfer',
      id: MNEE,
      amt: '500000',
    })
    expect(payload).toMatchObject({ op: 'transfer', id: MNEE, amt: '500000' })
  })

  it('rejects auth-only outputs (no balance)', () => {
    expect(
      parseBsv21Json({ p: 'bsv-20', op: 'deploy+auth', sym: 'STABLE', dec: '6' }),
    ).toBeNull()
    expect(parseBsv21Json({ p: 'bsv-20', op: 'auth', id: MNEE })).toBeNull()
  })

  it('rejects wrong protocol / missing fields', () => {
    expect(parseBsv21Json({ p: 'bsv-21', op: 'transfer', id: MNEE, amt: '1' })).toBeNull()
    expect(parseBsv21Json({ p: 'bsv-20', op: 'transfer', id: MNEE })).toBeNull()
  })

  it('round-trips customInstructions', () => {
    const raw = buildBsv21CustomInstructions({
      tokenId: MNEE,
      amt: '42',
      op: 'transfer',
      sym: 'MNEE',
      dec: 5,
    })
    expect(parseBsv21CustomInstructions(raw)).toMatchObject({
      id: MNEE,
      amt: '42',
      op: 'transfer',
      sym: 'MNEE',
      dec: 5,
    })
  })

  it('formats amounts with decimals', () => {
    expect(formatFungibleAmount('100000', 5)).toBe('1')
    expect(formatFungibleAmount('150000', 5)).toBe('1.5')
    expect(formatFungibleAmount('1000', 0)).toBe('1,000')
  })

  it('aggregates UTXOs by token id', () => {
    const rows = aggregateFungibles([
      {
        outpoint: 'aa.0',
        tokenId: MNEE,
        amt: '100',
        op: 'transfer',
        sym: 'MNEE',
        dec: 5,
        satoshis: 1,
      },
      {
        outpoint: 'bb.0',
        tokenId: MNEE,
        amt: '50',
        op: 'transfer',
        sym: 'MNEE',
        dec: 5,
        satoshis: 1,
      },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tokenId: MNEE,
      amt: '150',
      utxoCount: 2,
      sym: 'MNEE',
      spendKind: 'plain',
    })
  })

  it('aggregates cosigned tips and marks spendKind', () => {
    const pubkey = `02${'cd'.repeat(32)}`
    const rows = aggregateFungibles([
      {
        outpoint: 'aa.0',
        tokenId: MNEE,
        amt: '100',
        op: 'transfer',
        sym: 'MNEE',
        dec: 5,
        satoshis: 1,
        cosign: { pubkey },
      },
    ])
    expect(rows[0]).toMatchObject({ spendKind: 'cosigned', cosign: { pubkey } })
  })

  it('preserves cosign in customInstructions', () => {
    const pubkey = `03${'ef'.repeat(32)}`
    const raw = buildBsv21CustomInstructions({
      tokenId: MNEE,
      amt: '1',
      op: 'transfer',
      cosign: { pubkey, endpoint: 'https://cosign.example' },
    })
    expect(parseBsv21CustomInstructions(raw)?.cosign).toEqual({
      pubkey,
      endpoint: 'https://cosign.example',
    })
  })

  it('normalizes mime and token ids', () => {
    expect(isBsv21Mime('application/bsv-20')).toBe(true)
    expect(isBsv21Mime('image/png')).toBe(false)
    expect(normalizeTokenId(`${'ab'.repeat(32)}.3`)).toBe(`${'ab'.repeat(32)}_3`)
  })

  it('lists deploy+mint tips using the tip outpoint as token id', () => {
    const tip = `${'ab'.repeat(32)}.0`
    expect(
      tokenIdForListedTip({ outpoint: tip, op: 'deploy+mint' }),
    ).toBe(`${'ab'.repeat(32)}_0`)
  })

  it('tags token id as bsv21:<id>, not id:', () => {
    const tags = bsv21Tags({ tokenId: MNEE, amt: '1', sym: 'MNEE' })
    expect(tags).toContain('bsv21')
    expect(tags).toContain(`bsv21:${MNEE}`)
    expect(tags.some((t) => t.startsWith('id:'))).toBe(false)
    expect(tokenIdFromBsv21Tags(tags)).toBe(MNEE)
    expect(tokenIdFromBsv21Tags([`id:${MNEE}`])).toBe(MNEE) // legacy read
  })

  it('tags and CI carry issuer mirror', () => {
    const issuer = '02' + 'ab'.repeat(32)
    const tags = bsv21Tags({
      tokenId: MNEE,
      amt: '1',
      sym: 'Gold',
      issuer,
    })
    expect(tags).toContain(`issuer:${issuer}`)
    expect(tags).toContain('sym:gold') // tags lowercased
    const ci = JSON.parse(
      buildBsv21CustomInstructions({
        tokenId: MNEE,
        amt: '1',
        op: 'deploy+mint',
        sym: 'Gold',
        issuer,
      }),
    )
    expect(ci.issuer).toBe(issuer)
    expect(ci.sym).toBe('Gold')
  })
})

describe('extractBsv21FromGp', () => {
  // Local copy of the GP extractor is on oneSatImport — import for the real path.
  it('reads MNEE-shaped GorillaPool payloads', async () => {
    const { extractBsv21FromGp: extract } = await import('./oneSatImport')
    const tip = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.1'
    const holding = extract(
      {
        data: {
          insc: {
            file: { type: 'application/bsv-20' },
            json: {
              p: 'bsv-20',
              op: 'transfer',
              id: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
              amt: '250000',
            },
          },
          bsv20: {
            id: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
            op: 'transfer',
            amt: 250000,
          },
        },
      },
      tip,
    )
    expect(holding).toMatchObject({
      outpoint: tip,
      tokenId: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
      amt: '250000',
      op: 'transfer',
    })
  })
})
