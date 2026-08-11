/** BRC-232 trustholder types — aligned to BRC-CLOUD Worker wire. */

export type TrustholderOperator = 'handcash' | 'haste'

export type TrustholderInfo = {
  name: string
  version?: string
  role?: string
  authMethods: string[]
  portal?: string
  lifecycle?: {
    status: string
    sunsetAt?: string | null
    retireAt?: string | null
    message?: string | null
  }
  operator?: string
}

export type TrustholderAuthStart = {
  requestId: string
  expiresInSec: number
  action: {
    type: string
    channel?: string
    hint?: string
    challenge?: string
    /** Present when Worker is in email-dev mode. */
    devCode?: string
    /** True when this OTP also registers the email (first deposit). */
    enroll?: boolean
  }
}

export type TrustholderEnrollment = {
  operator: TrustholderOperator
  baseUrl: string
  shareIndex: number
  integrity: string
  enrolledAt: string
  emailHint?: string
}

export type TrustholderErrorBody = {
  error?: string
  message?: string
  portal?: string
}
