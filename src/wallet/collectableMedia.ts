const GLTF_MIMES = new Set([
  'model/gltf-binary',
  'model/gltf+json',
  'application/gltf-buffer',
  'application/gltf+json',
])

function normalizedMime(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * Decide how the collectable body is painted.
 *
 * GorillaPool content URLs do not carry a file extension, so the inscription
 * MIME is authoritative there. An extension remains useful for direct or
 * locally supplied media URLs.
 */
export function isCollectableModel(args: {
  mimeType?: string
  url?: string
}): boolean {
  if (GLTF_MIMES.has(normalizedMime(args.mimeType))) return true
  if (!args.url) return false
  try {
    return /\.(?:glb|gltf)$/i.test(new URL(args.url, window.location.href).pathname)
  } catch {
    return /\.(?:glb|gltf)(?:$|[?#])/i.test(args.url)
  }
}

export function collectableModelExtension(mimeType: string | undefined, url: string): 'glb' | 'gltf' {
  const mime = normalizedMime(mimeType)
  if (mime === 'model/gltf+json' || mime === 'application/gltf+json') return 'gltf'
  try {
    if (/\.gltf$/i.test(new URL(url, window.location.href).pathname)) return 'gltf'
  } catch {
    if (/\.gltf(?:$|[?#])/i.test(url)) return 'gltf'
  }
  return 'glb'
}
