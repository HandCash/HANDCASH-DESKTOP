/**
 * Orchestrate BRC-140 share deposit to independent trustholders.
 * Recommended layout is 2-of-3: [0]=HandCash, [1]=Haste, [2]=local offline —
 * but each operator deposits on its own; we only recommend completing both.
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
  retrieveShare,
  startDevTokenAuth,
  startEmailOtpAuth,
} from './client'
import {
  getTrustholderSharePlan,
  setTrustholderSharePlan,
  upsertTrustholderEnrollment,
  type TrustholderSharePlan,
} from './prefs'
import type { TrustholderEnrollment, TrustholderOperator } from './types'

export type TrustholderProvider = {
  operator: TrustholderOperator
  baseUrl: string
  label: string
  /** Fixed index in the recommended 2-of-3 share set. */
  shareIndex: number
  recommended?: boolean
}

/** Recommended cloud slots. Local offline is always index 2. */
export const LOCAL_SHARE_INDEX = 2

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
      shareIndex: 0,
      recommended: true,
    },
    {
      operator: 'haste',
      baseUrl: urls[1] || HASTE_BACKUP_SERVICE_URL,
      label: 'Haste',
      shareIndex: 1,
      recommended: true,
    },
  ]
}

export function getProvider(operator: TrustholderOperator): TrustholderProvider {
  const found = listTrustholderProviders().find((p) => p.operator === operator)
  if (!found) throw new Error(`Unknown trustholder ${operator}`)
  return found
}

export type DepositProgress = {
  operator: TrustholderOperator
  label: string
  phase: 'info' | 'auth' | 'otp' | 'deposit' | 'retrieve' | 'done' | 'error'
  message?: string
  /** When email-otp returns a local-only code (Worker without Resend). */
  devCode?: string
}

export type DepositOtpRequest = {
  operator: TrustholderOperator
  label: string
  hint?: string
  /** Prefill when Worker returns a local-only code. */
  devCode?: string
  /** First deposit — OTP registers the email in-app (no portal). */
  enroll?: boolean
}

export type DepositOneResult = {
  enrollment: TrustholderEnrollment
  /** Offline slice (index 2) — same for every deposit in this plan. */
  localShare: string
  integrity: string
  threshold: number
  totalShares: number
  /** How many recommended cloud operators are enrolled after this deposit. */
  enrolledRecommended: number
  recommendedTotal: number
}

/** Create or reuse the 2-of-3 plan so independent deposits share integrity. */
export async function ensureTrustholderSharePlan(password: string): Promise<TrustholderSharePlan> {
  const existing = getTrustholderSharePlan()
  if (
    existing &&
    existing.shares?.length === existing.totalShares &&
    existing.shares[LOCAL_SHARE_INDEX]
  ) {
    return existing
  }
  const rootKeyHex = await revealRootKeyHex(password)
  const shareSet = createBrc140Shares(rootKeyHex, 2, 3)
  const plan: TrustholderSharePlan = {
    integrity: shareSet.integrity,
    threshold: shareSet.threshold,
    totalShares: shareSet.totalShares,
    shares: shareSet.shares,
    createdAt: new Date().toISOString(),
  }
  setTrustholderSharePlan(plan)
  return plan
}

export function getLocalOfflineShare(): string | null {
  return getTrustholderSharePlan()?.shares[LOCAL_SHARE_INDEX] ?? null
}

/**
 * Deposit one share to a single trustholder. Operators are independent —
 * call once per provider. Shares come from one persisted 2-of-3 plan.
 * First-time email OTP registers the account in-app (Worker auto-enroll).
 */
export async function depositShareToTrustholder(args: {
  operator: TrustholderOperator
  password: string
  email: string
  preferEmailOtp?: boolean
  onProgress?: (p: DepositProgress) => void
  onOtpNeeded: (req: DepositOtpRequest) => Promise<string>
}): Promise<DepositOneResult> {
  const preferEmail = args.preferEmailOtp !== false
  const email = args.email.trim()
  if (preferEmail && !email.includes('@')) {
    throw new Error('Enter the email for this provider')
  }

  const provider = getProvider(args.operator)
  const plan = await ensureTrustholderSharePlan(args.password)
  const share = plan.shares[provider.shareIndex]
  const localShare = plan.shares[LOCAL_SHARE_INDEX]
  if (!share || !localShare) throw new Error('Share plan is incomplete — unlock and try again')

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

  const supportsEmailOtp = info.authMethods.includes('email-otp')

  args.onProgress?.({
    operator: provider.operator,
    label: provider.label,
    phase: 'auth',
    message: `Authenticating with ${provider.label}…`,
  })

  let requestId: string
  let otpCode: string | undefined
  let emailHint: string | undefined

  if (preferEmail && supportsEmailOtp) {
    const start = await startEmailOtpAuth(provider.baseUrl, email)
    requestId = start.requestId
    emailHint = start.action.hint
    const enroll = Boolean(start.action.enroll)
    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'otp',
      message: enroll
        ? `Enter the registration code for ${provider.label}`
        : `Enter the code sent for ${provider.label}`,
      devCode: start.action.devCode,
    })
    otpCode = await args.onOtpNeeded({
      operator: provider.operator,
      label: provider.label,
      hint: start.action.hint,
      devCode: start.action.devCode,
      enroll,
    })
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
    shareIndex: provider.shareIndex,
    integrity: plan.integrity,
    enrolledAt: new Date().toISOString(),
    emailHint,
  }
  const state = upsertTrustholderEnrollment(enrollment)

  const urls = listTrustholderProviders().map((p) => p.baseUrl)
  setWalletConfigPrefs({
    mode: 'recommended',
    backupServiceUrls: urls,
    configuredAt: Date.now(),
  })

  args.onProgress?.({
    operator: provider.operator,
    label: provider.label,
    phase: 'done',
    message: `${provider.label} enrolled`,
  })

  const recommended = listTrustholderProviders().filter((p) => p.recommended)
  const enrolledRecommended = recommended.filter((p) =>
    state.enrollments.some((e) => e.operator === p.operator),
  ).length

  return {
    enrollment,
    localShare,
    integrity: plan.integrity,
    threshold: plan.threshold,
    totalShares: plan.totalShares,
    enrolledRecommended,
    recommendedTotal: recommended.length,
  }
}

/**
 * Retrieve one BRC-140 share from a trustholder (new-device restore).
 * No local vault required — email OTP signs in to the same account used at deposit.
 */
export async function retrieveShareFromTrustholder(args: {
  operator: TrustholderOperator
  email: string
  preferEmailOtp?: boolean
  onProgress?: (p: DepositProgress) => void
  onOtpNeeded: (req: DepositOtpRequest) => Promise<string>
}): Promise<{
  share: string
  operator: TrustholderOperator
  label: string
  shareIndex: number
  emailHint?: string
}> {
  const preferEmail = args.preferEmailOtp !== false
  const email = args.email.trim()
  if (preferEmail && !email.includes('@')) {
    throw new Error('Enter the email used when you deposited to this provider')
  }

  const provider = getProvider(args.operator)

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

  const supportsEmailOtp = info.authMethods.includes('email-otp')

  args.onProgress?.({
    operator: provider.operator,
    label: provider.label,
    phase: 'auth',
    message: `Signing in to ${provider.label}…`,
  })

  let requestId: string
  let otpCode: string | undefined
  let emailHint: string | undefined

  if (preferEmail && supportsEmailOtp) {
    const start = await startEmailOtpAuth(provider.baseUrl, email)
    requestId = start.requestId
    emailHint = start.action.hint
    if (start.action.enroll) {
      throw new Error(
        `${provider.label} has no backup for this email yet — deposit from an unlocked wallet first, or use a different email.`,
      )
    }
    args.onProgress?.({
      operator: provider.operator,
      label: provider.label,
      phase: 'otp',
      message: `Enter the code sent for ${provider.label}`,
      devCode: start.action.devCode,
    })
    otpCode = await args.onOtpNeeded({
      operator: provider.operator,
      label: provider.label,
      hint: start.action.hint,
      devCode: start.action.devCode,
      enroll: false,
    })
  } else {
    const start = await startDevTokenAuth(provider.baseUrl)
    requestId = start.requestId
  }

  const { token } = await completeAuth(provider.baseUrl, requestId, otpCode)

  args.onProgress?.({
    operator: provider.operator,
    label: provider.label,
    phase: 'retrieve',
    message: `Retrieving share from ${provider.label}…`,
  })
  const { share } = await retrieveShare(provider.baseUrl, token)
  if (!share?.trim()) {
    throw new Error(`${provider.label} returned an empty share`)
  }

  args.onProgress?.({
    operator: provider.operator,
    label: provider.label,
    phase: 'done',
    message: `${provider.label} share ready`,
  })

  return {
    share: share.trim(),
    operator: provider.operator,
    label: provider.label,
    shareIndex: provider.shareIndex,
    emailHint,
  }
}

/** @deprecated Prefer {@link depositShareToTrustholder} per operator. */
export async function depositSharesToTrustholders(args: {
  password: string
  email: string
  preferEmailOtp?: boolean
  onProgress?: (p: DepositProgress) => void
  onOtpNeeded: (req: DepositOtpRequest) => Promise<string>
}): Promise<{
  enrollments: TrustholderEnrollment[]
  localShare: string
  integrity: string
  threshold: number
  totalShares: number
}> {
  const enrollments: TrustholderEnrollment[] = []
  let localShare = ''
  let integrity = ''
  let threshold = 2
  let totalShares = 3
  for (const provider of listTrustholderProviders()) {
    const one = await depositShareToTrustholder({
      ...args,
      operator: provider.operator,
    })
    enrollments.push(one.enrollment)
    localShare = one.localShare
    integrity = one.integrity
    threshold = one.threshold
    totalShares = one.totalShares
  }
  return { enrollments, localShare, integrity, threshold, totalShares }
}

