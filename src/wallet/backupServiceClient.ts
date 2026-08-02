/** HTTP client for pluggable backup services (share vault). */

export type BackupServiceLifecycle = {
  status: 'active' | 'sunset' | 'retired' | string
  sunsetAt?: string | null
  retireAt?: string | null
  message?: string | null
  successorUrl?: string | null
}

export type BackupServiceInfo = {
  name: string
  version?: string
  role?: string
  authMethods?: string[]
  requiresPasswordWithOtp?: boolean
  lifecycle: BackupServiceLifecycle
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function errMessage(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' ? body.error : fallback
}

export async function fetchBackupServiceInfo(baseUrl: string): Promise<BackupServiceInfo> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/info`)
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, `Could not reach backup service (${res.status})`))
  const lifecycle = (body.lifecycle && typeof body.lifecycle === 'object'
    ? body.lifecycle
    : { status: 'active' }) as BackupServiceLifecycle
  return {
    name: typeof body.name === 'string' ? body.name : base,
    version: typeof body.version === 'string' ? body.version : undefined,
    role: typeof body.role === 'string' ? body.role : undefined,
    authMethods: Array.isArray(body.authMethods)
      ? body.authMethods.filter((m): m is string => typeof m === 'string')
      : [],
    requiresPasswordWithOtp: Boolean(body.requiresPasswordWithOtp),
    lifecycle,
  }
}

export async function startBackupServiceAuth(
  baseUrl: string,
  email: string,
): Promise<{ requestId: string; devCode?: string }> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, 'Could not start auth'))
  if (typeof body.requestId !== 'string') throw new Error('Invalid auth/start response')
  return {
    requestId: body.requestId,
    devCode: typeof body.devCode === 'string' ? body.devCode : undefined,
  }
}

export async function verifyBackupServiceAuth(
  baseUrl: string,
  requestId: string,
  code: string,
): Promise<{ token: string; email: string }> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, code: code.trim() }),
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, 'Auth failed'))
  if (typeof body.token !== 'string') throw new Error('Invalid auth/verify response')
  return {
    token: body.token,
    email: typeof body.email === 'string' ? body.email : '',
  }
}

export async function enrollBackupShare(
  baseUrl: string,
  token: string,
  userIdHash: string,
  share: string,
): Promise<void> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/share/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userIdHash, share }),
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, 'Enroll failed'))
}

export async function retrieveBackupShare(
  baseUrl: string,
  token: string,
  userIdHash: string,
): Promise<string> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/share/retrieve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userIdHash }),
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, 'Retrieve failed'))
  if (typeof body.share !== 'string') throw new Error('Invalid retrieve response')
  return body.share
}

export async function deleteBackupShare(
  baseUrl: string,
  token: string,
  userIdHash: string,
): Promise<void> {
  const base = normalizeBase(baseUrl)
  const res = await fetch(`${base}/share/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userIdHash }),
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(errMessage(body, 'Delete failed'))
}

/** Stable user id for backup services: sha256(normalized email). */
export async function userIdHashFromEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isLifecycleWarning(lifecycle: BackupServiceLifecycle): boolean {
  if (lifecycle.status === 'sunset' || lifecycle.status === 'retired') return true
  if (lifecycle.retireAt) {
    const t = Date.parse(lifecycle.retireAt)
    if (!Number.isNaN(t) && t - Date.now() < 90 * 24 * 60 * 60 * 1000) return true
  }
  return false
}
