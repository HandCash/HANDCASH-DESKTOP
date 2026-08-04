/**
 * Orchestrate BRC-140 share deposit to HandCash + Haste trustholders.
 * Keeps 1 share offline (2-of-3): [0]=HandCash, [1]=Haste, [2]=local.
 */
import { createBrc140Shares } from '../brc140Backup'
import { revealRootKeyHex } from '../vault'
import {
  HANDCASH_BACKUP_SERVICE_URL,
  HASTE_BACKUP_SERVICE_URL,
  getWalletConfigPrefs,
  setWalletConfigPrefs,
} from '../walletConfig'
import {
  completeAuth,
  depositShare,
  fetchTrustholderInfo,
  startDevTokenAuth,
  startEmailOtpAuth,
  TrustholderHttpError,
} from './client'
import { upsertTrustholderEnrollment } from './prefs'
import type { TrustholderEnrollment, TrustholderOperator } from './types'

export type TrustholderProvider = {
  operator: TrustholderOperator
  baseUrl: string
  label: string
}

export function listTrustholderProviders(): TrustholderProvider[] {
  const prefs = getWalletConfigPrefs()
  const urls =
    prefs.backupServiceUrls.length >= 2
      ? prefs.backupServiceUrls
      : [HANDCASH_BACKUP_SERVICE_URL, HASTE_BACKUP_SERVICE_URL]
  return [
    {
      operator: 'handcash',
      baseUrl: urls[0] || HANDCASH_BACKUP_SERVICE_URL,
      label: 'HandCash',
    },
    {
      operator: 'haste',
      baseUrl: urls[1] || HASTE_BACKUP_SERVICE_URL,
      label: 'Haste',
    },
  ]
}

export type DepositProgress = {
  operator: TrustholderOperator
  label: string
  phase: 'info' | 'auth' | 'otp' | 'deposit' | 'done' | 'error'
  message?: string
  portal?: string
  /** When email-otp returns a local-only code (Worker without Resend). */
  devCode?: string
}

export type DepositOtpRequest = {
  operator: TrustholderOperator
  label: string
  hint?: string
  portal?: string
  /** Prefill when Worker returns a local-only code. */
  devCode?: string
}

export type DepositResult = {
  enrollments: TrustholderEnrollment[]
  /** Share kept offline (index 2). Download / print this — do not deposit it. */
  localShare: string
  integrity: string
  threshold: number
  totalShares: number
}

export async function depositSharesToTrustholders(args: {
  password: string
  email: string
  /** Prefer email-otp when registered; fall back to dev-token if Worker allows. */
  preferEmailOtp?: boolean
  onProgress?: (p: DepositProgress) => void
  onOtpNeeded: (req: DepositOtpRequest) => Promise<string>
}): Promise<DepositResult> {
  const preferEmail = args.preferEmailOtp !== false
  const email = args.email.trim()
  if (preferEmail && !email.includes('@')) {
    throw new Error('Enter the email registered with HandCash and Haste portals')
  }

  const rootKeyHex = await revealRootKeyHex(args.password)
  const providers = listTrustholderProviders()
  const shareSet = createBrc140Shares(rootKeyHex, 2, 3)
  const localShare = shareSet.shares[2]
  if (!localShare) throw new Error('Missing local recovery share')

  const results: TrustholderEnrollment[] = []

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!
    const share = shareSet.shares[i]
    if (!share) throw new Error(`Missing share for ${provider.label}`)

    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'info',
      message: `Checking ${provider.label}…`,
    })
    const info = await fetchTrustholderInfo(provider.baseUrl)
    if (info.lifecycle?.status && info.lifecycle.status !== 'active') {
      throw new Error(
        `${provider.label} is ${info.lifecycle.status}${info.lifecycle.message ? `: ${info.lifecycle.message}` : ''}`,
      )
    }

    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'auth',
      message: `Authenticating with ${provider.label}…`,
      portal: info.portal,
    })

    let requestId: string
    let otpCode: string | undefined
    let emailHint: string | undefined

    if (preferEmail) {
      try {
        const start = await startEmailOtpAuth(provider.baseUrl, email)
        requestId = start.requestId
        emailHint = start.action.hint
        args.onProgress?.({
          operator: provider.operator,
          label: provider.label,
          phase: 'otp',
          message: `Enter the code sent for ${provider.label}`,
          portal: info.portal,
          devCode: start.action.devCode,
        })
        otpCode = await args.onOtpNeeded({
          operator: provider.operator,
          label: provider.label,
          hint: start.action.hint,
          portal: info.portal,
          devCode: start.action.devCode,
        })
      } catch (err) {
        if (err instanceof TrustholderHttpError && err.code === 'not-registered') {
          throw new TrustholderHttpError(404, {
            error: 'not-registered',
            message:
              err.message ||
              `Register ${email} at the ${provider.label} portal first, then try again.`,
            portal: err.portal || info.portal,
          })
        }
        // Fall back to dev-token when email-otp path is unavailable.
        const start = await startDevTokenAuth(provider.baseUrl)
        requestId = start.requestId
      }
    } else {
      const start = await startDevTokenAuth(provider.baseUrl)
      requestId = start.requestId
    }

    const { token } = await completeAuth(provider.baseUrl, requestId, otpCode)

    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'deposit',
      message: `Depositing share to ${provider.label}…`,
    })
    await depositShare(provider.baseUrl, token, share)

    const enrollment: TrustholderEnrollment = {
      operator: provider.operator,
      baseUrl: provider.baseUrl,
      shareIndex: i,
      integrity: shareSet.integrity,
      enrolledAt: new Date().toISOString(),
      emailHint,
    }
    upsertTrustholderEnrollment(enrollment)
    results.push(enrollment)

    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'done',
      message: `${provider.label} enrolled`,
    })
  }

  // Keep local third share offline — mark recommended prefs.
  const urls = providers.map((p) => p.baseUrl)
  setWalletConfigPrefs({
    mode: 'recommended',
    backupServiceUrls: urls,
    configuredAt: Date.now(),
  })

  return {
    enrollments: results,
    localShare,
    integrity: shareSet.integrity,
    threshold: shareSet.threshold,
    totalShares: shareSet.totalShares,
  }
}
