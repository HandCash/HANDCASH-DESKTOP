import { describe, expect, it, vi } from 'vitest'
import { LockingScript, Transaction } from '@bsv/sdk'
import { B_PROTOCOL_PREFIX, decodeBProtocol } from './bProtocol'
import { cacheTokenIconFromBeef } from './token'
import { getTokenIconDataUrl } from './token'
import type { ActiveWallet } from './session'

const fetchRawTxHex = vi.fn<(txid: string) => Promise<string | null>>()
vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: (txid: string) => fetchRawTxHex(txid),
}))
vi.mock('./beefCache', () => ({
  getLocalTxForTxid: async () => null,
}))

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function push(data: Uint8Array): string {
  const payload = [...data].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (data.length <= 75) return data.length.toString(16).padStart(2, '0') + payload
  throw new Error('push too long')
}

function encodeText(s: string): string {
  return push(new TextEncoder().encode(s))
}

describe('tokenIconResolve B-protocol', () => {
  it('hydrates an image mime from a B-protocol script', () => {
    const script = (
      '006a' +
      encodeText(B_PROTOCOL_PREFIX) +
      push(PNG) +
      encodeText('image/png') +
      encodeText('binary')
    )
    expect(decodeBProtocol(script)?.mediaType).toBe('image/png')
    const txid = 'ab'.repeat(32)
    const outpoint = `${txid}_1`
    const url = cacheTokenIconFromBeef(outpoint, {
      findTxid: () => ({
        tx: {
          outputs: [
            { lockingScript: `76a914${'11'.repeat(20)}88ac` },
            { lockingScript: script },
          ],
        },
      }),
    })
    expect(url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(getTokenIconDataUrl(outpoint)?.startsWith('data:image/png')).toBe(true)
  })
})

describe('received token icons', () => {
  const script = LockingScript.fromHex(
    '006a' +
      encodeText(B_PROTOCOL_PREFIX) +
      push(PNG) +
      encodeText('image/png') +
      encodeText('binary'),
  )
  const iconTx = new Transaction()
  iconTx.addOutput({ satoshis: 1, lockingScript: script })
  const iconTxid = iconTx.id('hex')
  const wallet = { chain: 'main' } as unknown as ActiveWallet

  it("resolves the issuer's icon from a provider body this wallet never held", async () => {
    // A received token names an icon on a transaction the wallet did not sign
    // or ingest; local-only resolution drew every such token blank.
    fetchRawTxHex.mockResolvedValueOnce(iconTx.toHex())
    const { resolveTokenIconDataUrl } = await import('./token/icons/resolve')
    const url = await resolveTokenIconDataUrl(`${iconTxid}_0`, wallet)
    expect(url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(fetchRawTxHex).toHaveBeenCalledWith(iconTxid)
  })

  it('refuses a provider body that does not hash to the icon txid', async () => {
    const other = new Transaction()
    other.addOutput({ satoshis: 2, lockingScript: script })
    const claimed = 'ee'.repeat(32)
    fetchRawTxHex.mockResolvedValueOnce(other.toHex())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { resolveTokenIconDataUrl } = await import('./token/icons/resolve')
    expect(await resolveTokenIconDataUrl(`${claimed}_0`, wallet)).toBeUndefined()
    expect(getTokenIconDataUrl(`${claimed}_0`)).toBeUndefined()
    warn.mockRestore()
  })
})
