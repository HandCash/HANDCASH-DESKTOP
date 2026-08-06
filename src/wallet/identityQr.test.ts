import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async (key: string) => `data:image/png;base64,${key}`),
  },
}))

import QRCode from 'qrcode'
import {
  identityQrDataUrl,
  peekIdentityQrDataUrl,
  resetIdentityQrCacheForTests,
} from './identityQr'

describe('identityQr', () => {
  afterEach(() => {
    resetIdentityQrCacheForTests()
    vi.mocked(QRCode.toDataURL).mockClear()
  })

  it('generates once and reuses the cached data URL', async () => {
    const first = await identityQrDataUrl('abc')
    const second = await identityQrDataUrl('abc')
    expect(first).toBe('data:image/png;base64,abc')
    expect(second).toBe(first)
    expect(QRCode.toDataURL).toHaveBeenCalledTimes(1)
    expect(peekIdentityQrDataUrl('abc')).toBe(first)
  })
})
