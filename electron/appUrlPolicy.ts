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

/** Only the exact renderer origin or a file below dist may keep navigation. */
export function isTrustedAppUrl(raw: string, policy: AppUrlPolicy): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

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
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  } catch {
    return false
  }
}
