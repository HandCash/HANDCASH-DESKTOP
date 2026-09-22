import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { chooseBsv21ListingLock } from './marketListingPath'
import { buildBsv21ValueLock } from './token/sendPlan'

const TOKEN_ID = `${'ab'.repeat(32)}_0`
const address = PrivateKey.fromRandom().toAddress()
const P2PKH = `76a914${'11'.repeat(20)}88ac`

function hex(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** OP_FALSE OP_IF "ord" OP_1 <mime> OP_0 <body> OP_ENDIF ‖ P2PKH */
function jsonTip(payload: unknown, mime = 'application/bsv-20'): string {
  const body = hex(JSON.stringify(payload))
  const len = body.length / 2
  const push =
    len < 0x4c ? len.toString(16).padStart(2, '0') : `4c${len.toString(16).padStart(2, '0')}`
  const mimeHex = hex(mime)
  return (
    '0063036f726451' +
    (mimeHex.length / 2).toString(16).padStart(2, '0') +
    mimeHex +
    '00' +
    push +
    body +
    '68' +
    P2PKH
  )
}

describe('chooseBsv21ListingLock', () => {
  it('accepts a 162 value lock and reads its id and amount', () => {
    const lock = chooseBsv21ListingLock(
      buildBsv21ValueLock({ tokenId: TOKEN_ID, amount: 250n, address }),
    )
    expect(lock).toMatchObject({ lock: 'value', tokenId: TOKEN_ID, amount: 250n })
  })

  it('names a missing script as a local read to retry, not a bad asset', () => {
    for (const empty of [undefined, '', '   ']) {
      const lock = chooseBsv21ListingLock(empty)
      expect(lock).toMatchObject({ lock: 'refuse', reason: 'no-locking-script' })
      if (lock.lock === 'refuse') expect(lock.message).toMatch(/Refresh/i)
    }
  })

  /**
   * The message every legacy holder hit said "requires a 162 value lock",
   * which reads as a transient wallet fault. It is permanent: settlement can
   * only build a 162 buyer output, so a JSON tip has no listing to publish.
   */
  it('names a legacy JSON holding as read-only rather than a missing lock', () => {
    const transfer = jsonTip({ p: 'bsv-20', op: 'transfer', id: TOKEN_ID, amt: '60' })
    const lock = chooseBsv21ListingLock(transfer)
    expect(lock).toMatchObject({ lock: 'refuse', reason: 'legacy-json' })
    if (lock.lock === 'refuse') expect(lock.message).toMatch(/read-only/i)

    const genesis = jsonTip({ p: 'bsv-20', op: 'deploy+mint', sym: 'COPE', amt: '4444444' })
    expect(chooseBsv21ListingLock(genesis)).toMatchObject({ reason: 'legacy-json' })
  })

  it('does not call a plain P2PKH or an image inscription a legacy token', () => {
    expect(chooseBsv21ListingLock(P2PKH)).toMatchObject({
      lock: 'refuse',
      reason: 'not-a-token',
    })
    expect(chooseBsv21ListingLock(jsonTip({ hi: 1 }, 'image/png'))).toMatchObject({
      reason: 'not-a-token',
    })
  })

  it('is case insensitive about the script it is handed', () => {
    const upper = buildBsv21ValueLock({
      tokenId: TOKEN_ID,
      amount: 7n,
      address,
    }).toUpperCase()
    expect(chooseBsv21ListingLock(upper)).toMatchObject({ lock: 'value', amount: 7n })
  })
})
