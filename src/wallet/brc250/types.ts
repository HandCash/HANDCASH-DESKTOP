export const BRC250_HOST =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_BRC250_HOST === 'string' &&
    import.meta.env.VITE_BRC250_HOST.trim()) ||
  'https://brc250-google.bcryderman.workers.dev'

export type Brc250Purpose = 'enroll' | 'login'

export type Brc250Identifier = {
  v: 1
  purpose: Brc250Purpose
  accountRef: string
  loginKey: string
  commitment: string
  context: string
  binding: string
  iat: number
  exp: number
  signature: string
}

export type GoogleLoginProof = {
  identifier: Brc250Identifier
  method: 'google-id-token'
  idToken: string
}

export type GoogleAttempt = {
  binding: string
  expiresAt: number
  openUrl: string
}

export type GoogleAttemptStatus =
  | { state: 'waiting'; expiresAt: number }
  | { state: 'expired' }
  | { state: 'ready'; loginProof: GoogleLoginProof }

export type EmailRecoveryEnrollment = {
  v: 1
  host: string
  email: string
  authorityKey: string
  attesterKey: string
  master: { derivation: 'brc-42' } | { derivation: 'brc-157'; entropyLength: number }
  mailboxConfirmed: boolean
  enrolledAt: number
}

export type PendingGoogleRecovery = {
  purpose: Brc250Purpose
  loginKeyHex: string
  loginKey: string
  rA: string
  commitment: string
  binding: string
  openUrl: string
  expiresAt: number
}

export type LoginStart = {
  binding: string
  authorityKey: string
  recentDevices: Array<{ deviceId: string; label: string; lastSeen: number }>
  releaseAt: number | null
}

export type LoginStatus = {
  binding: string
  state: 'open' | 'challenged' | 'revealed' | 'sent' | 'refused' | 'released'
  context: string
  rB: string | null
  rA: string | null
  deviceId: string | null
  sealedVault: string | null
  releaseAt: number | null
  expiresAt: number
}
