import { playWalletSound } from './soundService'
import { toastCopied, toastError, toastSuccess } from './toast'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export type ImageBytes = {
  blob: Blob
  mime: string
  ext: string
  bytes: Uint8Array
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

export function extFromMime(mime: string | undefined, fallback = 'png'): string {
  const key = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  return MIME_EXT[key] ?? fallback
}

export function filenameForCollectable(name: string, ext: string): string {
  const stem =
    name
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'collectable'
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  return `${stem}.${safeExt}`
}

function mimeLooksLikeImage(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/')
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  if (typeof createImageBitmap !== 'function') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (!png) throw new Error('png encode failed')
    return png
  } finally {
    bitmap.close()
  }
}

async function bytesFromPaintedImg(img: HTMLImageElement): Promise<ImageBytes> {
  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error('image is not loaded')
  }
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(img, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  if (!blob) throw new Error('could not read image pixels')
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large to copy')
  return {
    blob,
    mime: 'image/png',
    ext: 'png',
    bytes: await blobToBytes(blob),
  }
}

export async function loadImageBytes(
  url: string,
  opts?: { mimeHint?: string; paintedImg?: HTMLImageElement | null },
): Promise<ImageBytes> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
    if (!res.ok) throw new Error(`image fetch failed (${res.status})`)
    const blob = await res.blob()
    if (blob.size <= 0) throw new Error('empty image')
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large to copy')
    const mime = blob.type || opts?.mimeHint || 'image/png'
    if (!mimeLooksLikeImage(mime) && opts?.mimeHint && mimeLooksLikeImage(opts.mimeHint)) {
      return {
        blob,
        mime: opts.mimeHint,
        ext: extFromMime(opts.mimeHint),
        bytes: await blobToBytes(blob),
      }
    }
    if (!mimeLooksLikeImage(mime)) {
      throw new Error('not an image')
    }
    return {
      blob,
      mime,
      ext: extFromMime(mime),
      bytes: await blobToBytes(blob),
    }
  } catch (err) {
    if (opts?.paintedImg) {
      try {
        return await bytesFromPaintedImg(opts.paintedImg)
      } catch {
        /* keep original error */
      }
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}

async function writeClipboardImage(bytes: ImageBytes): Promise<boolean> {
  try {
    if (window.handcash?.clipboardWriteImage) {
      await window.handcash.clipboardWriteImage({
        mime: bytes.mime,
        base64: bytesToBase64(bytes.bytes),
      })
      return true
    }
  } catch {
    /* fall through */
  }

  try {
    const item = mimeLooksLikeImage(bytes.mime) ? bytes.blob : await toPngBlob(bytes.blob)
    const mime = item.type || 'image/png'
    await navigator.clipboard.write([new ClipboardItem({ [mime]: item })])
    return true
  } catch {
    try {
      const png = await toPngBlob(bytes.blob)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return true
    } catch {
      return false
    }
  }
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const href = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    a.rel = 'noopener'
    a.click()
  } finally {
    URL.revokeObjectURL(href)
  }
}

async function shareBlob(blob: Blob, filename: string): Promise<boolean> {
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (typeof nav.share !== 'function' || typeof File === 'undefined') return false
  try {
    const file = new File([blob], filename, { type: blob.type || 'image/png' })
    const data = { files: [file], title: filename } as ShareData
    if (typeof nav.canShare === 'function' && !nav.canShare(data)) return false
    await nav.share(data)
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return true
    return false
  }
}

export async function copyCollectableImage(args: {
  url: string
  mimeHint?: string
  paintedImg?: HTMLImageElement | null
}): Promise<boolean> {
  try {
    const bytes = await loadImageBytes(args.url, {
      mimeHint: args.mimeHint,
      paintedImg: args.paintedImg,
    })
    const ok = await writeClipboardImage(bytes)
    if (ok) {
      playWalletSound('copy')
      toastCopied('image')
      return true
    }
    playWalletSound('error')
    toastError('Couldn’t copy image')
    return false
  } catch (err) {
    playWalletSound('error')
    toastError('Couldn’t copy image', err instanceof Error ? err.message : String(err))
    return false
  }
}

export async function saveCollectableImage(args: {
  url: string
  name: string
  mimeHint?: string
  paintedImg?: HTMLImageElement | null
}): Promise<boolean> {
  try {
    const bytes = await loadImageBytes(args.url, {
      mimeHint: args.mimeHint,
      paintedImg: args.paintedImg,
    })
    const filename = filenameForCollectable(args.name, bytes.ext)

    try {
      if (window.handcash?.saveImageFile) {
        const result = await window.handcash.saveImageFile({
          filename,
          mime: bytes.mime,
          base64: bytesToBase64(bytes.bytes),
        })
        if (!result.ok) throw new Error(result.error || 'save failed')
        if (result.canceled) return true
        playWalletSound('soft')
        const toGallery =
          typeof navigator !== 'undefined' &&
          /android|iphone|ipad/i.test(navigator.userAgent)
        toastSuccess(toGallery ? 'Saved to gallery' : 'Image saved')
        return true
      }
    } catch (err) {
      if (err instanceof Error && /canceled|abort/i.test(err.message)) return true
      /* fall through to web save */
    }

    if (await shareBlob(bytes.blob, filename)) {
      playWalletSound('soft')
      toastSuccess('Save or share the image')
      return true
    }

    await downloadBlob(bytes.blob, filename)
    playWalletSound('soft')
    toastSuccess('Image saved')
    return true
  } catch (err) {
    playWalletSound('error')
    toastError('Couldn’t save image', err instanceof Error ? err.message : String(err))
    return false
  }
}
