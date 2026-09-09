import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type AppUrlPolicy = {
  devOrigins: readonly string[]
  packagedUiOrigin: string | null
  distRoot: string
}

function exactOrigin(url: URL, allowed: string): boolean {
  try {
    return url.origin === new URL(allowed).origin
  } catch {
    return false
  }
}

function trustedHttpOrigins(policy: AppUrlPolicy): string[] {
  const origins = [...policy.devOrigins]
  if (policy.packagedUiOrigin) origins.push(policy.packagedUiOrigin)
  return origins.filter((origin) => {
    try {
      return new URL(origin).protocol === 'http:'
    } catch {
      return false
    }
  })
}

/**
 * Chromium HTTPS-First / automatic upgrades rewrite our HTTP UI origin to
 * `https://localhost:5173`. Vite and the packaged UI server speak HTTP only, so
 * that load fails with ERR_SSL_PROTOCOL_ERROR and the BRC-100 bridge loses its
 * renderer. Map the forced HTTPS URL back to the trusted HTTP origin.
 */
export function rewriteForcedHttpsUiUrl(
  raw: string,
  policy: AppUrlPolicy,
): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  for (const origin of trustedHttpOrigins(policy)) {
    let http: URL
    try {
      http = new URL(origin)
    } catch {
      continue
    }
    if (url.hostname !== http.hostname || url.port !== http.port) continue
    const rewritten = new URL(url.href)
    rewritten.protocol = 'http:'
    return rewritten.href
  }
  return null
}

/** True when this is our wallet UI origin forced onto https://. */
export function isForcedHttpsUiUrl(raw: string, policy: AppUrlPolicy): boolean {
  return rewriteForcedHttpsUiUrl(raw, policy) != null
}

/** Only the exact renderer origin or a file below dist may keep navigation. */
export function isTrustedAppUrl(raw: string, policy: AppUrlPolicy): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  // Never treat https://localhost:5173 as the wallet UI. Vite / the packaged UI
  // speak HTTP only; allowing that navigation blanks the renderer and breaks
  // every BRC-100 /getVersion (renderer-not-ready).
  if (
    policy.devOrigins.some((origin) => exactOrigin(url, origin)) ||
    (policy.packagedUiOrigin && exactOrigin(url, policy.packagedUiOrigin))
  ) {
    return true
  }
  if (url.protocol !== 'file:') return false

  try {
    const root = path.resolve(policy.distRoot)
    const candidate = path.resolve(fileURLToPath(url))
    const relative = path.relative(root, candidate)
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    )
  } catch {
    return false
  }
}
