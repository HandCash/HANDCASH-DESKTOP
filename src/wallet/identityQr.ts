import QRCode from 'qrcode'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

/** Identity QR is deterministic — generate once per key, reuse across tab visits. */
export function identityQrDataUrl(identityKey: string): Promise<string> {
  const key = identityKey.trim()
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)

  const pending = inflight.get(key)
  if (pending) return pending

  const run = QRCode.toDataURL(key, {
    width: 220,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  }).then((url) => {
    cache.set(key, url)
    inflight.delete(key)
    return url
  })

  inflight.set(key, run)
  return run.catch((err) => {
    inflight.delete(key)
    throw err
  })
}

export function peekIdentityQrDataUrl(identityKey: string): string | null {
  return cache.get(identityKey.trim()) ?? null
}

/** Test hook. */
export function resetIdentityQrCacheForTests(): void {
  cache.clear()
  inflight.clear()
}
