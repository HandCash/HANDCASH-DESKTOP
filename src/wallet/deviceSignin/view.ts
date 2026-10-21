/** How a sign-in request reads on an Activity row, from request to outcome. */
import type { SigninRequest } from './api'

export type SigninRowFace =
  | 'waiting'
  | 'claimed'
  | 'comparing'
  | 'elsewhere'
  | 'approved'
  | 'refused'
  | 'expired'
  | 'unreachable'

export type SigninRowView = {
  key: string
  binding: string
  /** `local`: scanned QR, straight over the local network. `relay`: email sign-in through HandCash. */
  via: 'local' | 'relay'
  face: SigninRowFace
  title: string
  detail: string
  label: string
  location: string
  createdAt: number
  expiresAt: number
  code: string | null
  /** Still waits on someone: approve and refuse apply. */
  live: boolean
}

export function signinRowView(
  request: SigninRequest,
  here: { deviceId: string; claimed: boolean; code: string | null },
): SigninRowView {
  const base = {
    key: `signin:${request.binding}`,
    binding: request.binding,
    via: 'relay' as const,
    label: request.label,
    location: request.location,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    code: null,
  }
  const requested = `Sign-in requested on ${request.label}`
  switch (request.state) {
    case 'sent':
    case 'received':
      return {
        ...base,
        face: 'approved',
        title: `Signed in on ${request.label}`,
        detail: request.approverLabel ? `Approved on ${request.approverLabel}` : 'Approved',
        live: false,
      }
    case 'refused':
      return { ...base, face: 'refused', title: 'Sign-in refused', detail: request.label, live: false }
    case 'expired':
      return {
        ...base,
        face: 'expired',
        title: 'Sign-in expired',
        detail: `${request.label} · nobody approved it`,
        live: false,
      }
    case 'open':
      return {
        ...base,
        face: 'waiting',
        title: requested,
        detail: request.location
          ? `Near ${request.location} · waits on your approval`
          : 'Waits on your approval',
        live: true,
      }
    case 'challenged':
    case 'revealed': {
      if (request.deviceId !== here.deviceId || !here.claimed) {
        return {
          ...base,
          face: 'elsewhere',
          title: requested,
          detail: `Waits on approval on ${request.approverLabel ?? 'another device'}`,
          live: true,
        }
      }
      if (here.code) {
        return { ...base, face: 'comparing', title: requested, detail: 'Compare the code, then approve', code: here.code, live: true }
      }
      return { ...base, face: 'claimed', title: requested, detail: `Waits on the code from ${request.label}`, live: true }
    }
  }
}

export function signinAlertText(request: SigninRequest): { title: string; body: string } {
  return {
    title: `Sign-in requested on ${request.label}`,
    body: `${request.location ? `Near ${request.location}. ` : ''}Approve or refuse it in Activity.`,
  }
}
