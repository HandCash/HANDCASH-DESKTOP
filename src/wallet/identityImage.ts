import { IDENTITY_IMAGE_MAX_BYTES, issuerIdentityImage, type IssuerIdentityImage } from './issuerIdentity'

const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const SIDES = [512, 384, 256, 192]
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5]

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Re-encode a picked picture for a B:// identity image: centre square crop, at
 * most 512px, WebP (JPEG where WebP encoding is unsupported), under 64 KB.
 * Drawing through a canvas drops EXIF and every other source metadata block,
 * which matters because the published file is public and permanent.
 */
export async function encodeIdentityImage(file: Blob): Promise<IssuerIdentityImage> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Image is too large to read (25 MB maximum).')
  if (typeof createImageBitmap !== 'function') throw new Error('This device cannot read images.')
  const started = Date.now()
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const crop = Math.min(bitmap.width, bitmap.height)
    if (!crop) throw new Error('Image has no pixels.')
    const sx = (bitmap.width - crop) / 2
    const sy = (bitmap.height - crop) / 2
    const canvas = document.createElement('canvas')
    for (const max of SIDES) {
      const side = Math.min(max, crop)
      canvas.width = side
      canvas.height = side
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('This device cannot draw images.')
      ctx.clearRect(0, 0, side, side)
      ctx.drawImage(bitmap, sx, sy, crop, crop, 0, 0, side, side)
      for (const quality of QUALITIES) {
        let blob = await encode(canvas, 'image/webp', quality)
        if (blob?.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality)
        if (!blob || blob.size > IDENTITY_IMAGE_MAX_BYTES) continue
        const image = issuerIdentityImage({
          contentType: blob.type,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        })
        const ms = Date.now() - started
        if (ms > 250) console.info(`[identity-image] encode done ${ms}ms`)
        return image
      }
    }
    throw new Error('Could not fit this image in 64 KB. Try a simpler picture.')
  } finally {
    bitmap.close()
  }
}
