import { describe, expect, it } from 'vitest'
import { P2PKH } from '@bsv/sdk'
import {
  isOwnershipUnjudged,
  liveOneSatKeys,
  outpointKey,
  partitionByLiveUtxos,
  shouldRejectSendForMissingLiveTip,
  OWNERSHIP_SETTLE_GRACE_MS,
} from './collectableOwnership'

const TX = 'a'.repeat(64)
const TX2 = 'b'.repeat(64)
const OUR_ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const OUR_SCRIPT = new P2PKH().lock(OUR_ADDRESS).toHex()
const OTHER_SCRIPT = new P2PKH().lock('1CounterpartyXXXXXXXXXXXXXXXUWLpVr').toHex()

describe('collectableOwnership', () => {
  it('normalizes underscore outpoints to dotted keys', () => {
    expect(outpointKey(`${TX}_0`)).toBe(`${TX}.0`)
    expect(outpointKey(`${TX}.0`)).toBe(`${TX}.0`)
  })

  it('keeps only 1-sat outpoints from an address scan', () => {
    const keys = liveOneSatKeys([
      { outpoint: `${TX}.0`, satoshis: 1 },
      { outpoint: `${TX}.1`, satoshis: 2 },
      { outpoint: `${TX2}.0`, satoshis: 5000 },
      { outpoint: `${TX2}_1`, satoshis: 1 },
    ])
    expect([...keys].sort()).toEqual([`${TX}.0`, `${TX2}.1`].sort())
  })

  it('drops basket tips the address no longer holds', () => {
    const live = liveOneSatKeys([{ outpoint: `${TX}.0`, satoshis: 1 }])
    const { owned, spentOrMissing } = partitionByLiveUtxos(
      [
        { outpoint: `${TX}.0`, satoshis: 1 },
        { outpoint: `${TX2}.0`, satoshis: 1 },
      ],
      live,
    )
    expect(owned.map((o) => o.outpoint)).toEqual([`${TX}.0`])
    expect(spentOrMissing.map((o) => o.outpoint)).toEqual([`${TX2}.0`])
  })

  it('treats underscore basket rows as matching dotted live keys', () => {
    const live = liveOneSatKeys([{ outpoint: `${TX}.0`, satoshis: 1 }])
    const { owned, spentOrMissing } = partitionByLiveUtxos(
      [{ outpoint: `${TX}_0`, satoshis: 1 }],
      live,
    )
    expect(owned).toHaveLength(1)
    expect(spentOrMissing).toHaveLength(0)
  })

  it('spares a tip newer than the live scan', () => {
    expect(
      isOwnershipUnjudged({
        firstSeenAt: 2_000,
        liveAt: 1_000,
        now: 2_500,
        graceMs: OWNERSHIP_SETTLE_GRACE_MS,
      }),
    ).toBe(true)
  })

  it('spares a tip inside settle grace even when the scan is newer', () => {
    // Self-send: tip lands in the basket, then a lagging address scan omits it.
    expect(
      isOwnershipUnjudged({
        firstSeenAt: 1_000,
        liveAt: 2_000,
        now: 1_000 + 60_000,
        graceMs: OWNERSHIP_SETTLE_GRACE_MS,
      }),
    ).toBe(true)
  })

  it('judges a tip once settle grace has elapsed and the scan is newer', () => {
    expect(
      isOwnershipUnjudged({
        firstSeenAt: 1_000,
        liveAt: 1_000 + OWNERSHIP_SETTLE_GRACE_MS + 1,
        now: 1_000 + OWNERSHIP_SETTLE_GRACE_MS + 1,
        graceMs: OWNERSHIP_SETTLE_GRACE_MS,
      }),
    ).toBe(false)
  })

  it('does not reject a send when the tip is still inside settle grace', () => {
    const now = 50_000
    expect(
      shouldRejectSendForMissingLiveTip({
        outpoint: `${TX}.0`,
        inLiveSet: false,
        firstSeenAt: now - 60_000,
        liveScanAt: now - 120_000,
        now,
        lockingScriptHex: OUR_SCRIPT,
        walletAddress: OUR_ADDRESS,
      }),
    ).toBe(false)
  })

  it('does not reject a send when the tip arrived after the address scan', () => {
    expect(
      shouldRejectSendForMissingLiveTip({
        outpoint: `${TX}.0`,
        inLiveSet: false,
        firstSeenAt: 5_000,
        liveScanAt: 1_000,
        now: 5_500,
        lockingScriptHex: OUR_SCRIPT,
        walletAddress: OUR_ADDRESS,
      }),
    ).toBe(false)
  })

  it('rejects a send when the scan proves an outbound remittance tip is gone', () => {
    const now = 1_000 + OWNERSHIP_SETTLE_GRACE_MS + 5_000
    expect(
      shouldRejectSendForMissingLiveTip({
        outpoint: `${TX}.0`,
        inLiveSet: false,
        firstSeenAt: 1_000,
        liveScanAt: now - 1_000,
        now,
        lockingScriptHex: OTHER_SCRIPT,
        walletAddress: OUR_ADDRESS,
      }),
    ).toBe(true)
  })
})
