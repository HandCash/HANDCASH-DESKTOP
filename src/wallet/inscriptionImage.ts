/**
 * Image type for inscription bytes held locally.
 *
 * An inscription declares its own content type, but plenty declare
 * `application/octet-stream` (or nothing) while carrying a PNG, so the magic
 * bytes settle it. Shared by the BSV-21 icon cache and item art — both paint
 * from transactions this device already holds, never a content indexer.
 */

export function sniffImageMime(body: Uint8Array): string | undefined {
  if (
    body.length >= 8 &&
    body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  ) {
    return 'image/png'
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    body.length >= 12 &&
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    body.length >= 6 &&
    body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x38
  ) {
    return 'image/gif'
  }
  const head = new TextDecoder()
    .decode(body.subarray(0, Math.min(body.length, 96)))
    .trimStart()
    .toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml'
  }
  return undefined
}

/** The image mime to paint with, or undefined when the body is not an image. */
export function imageMimeFor(
  declared: string | undefined,
  body: Uint8Array,
): string | undefined {
  const m = (declared ?? '').toLowerCase().split(';')[0]!.trim()
  if (m.startsWith('image/')) return m
  if (m === 'application/octet-stream' || !m) return sniffImageMime(body)
  return undefined
}
