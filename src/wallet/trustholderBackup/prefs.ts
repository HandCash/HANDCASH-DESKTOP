import { durableGetItem, durableSetItem } from '../durableStorage'
import type { TrustholderEnrollment, TrustholderOperator } from './types'

const KEY = 'handcash.brc100.trustholderEnrollments.v1'
const PLAN_KEY = 'handcash.brc100.trustholderSharePlan.v1'

export type TrustholderEnrollmentState = {
  enrollments: TrustholderEnrollment[]
  updatedAt: number | null
}

/** Local 2-of-3 plan so each trustholder can enroll independently. */
export type TrustholderSharePlan = {
  integrity: string
  threshold: number
  totalShares: number
  shares: string[]
  createdAt: string
}

const DEFAULTS: TrustholderEnrollmentState = {
  enrollments: [],
  updatedAt: null,
}

export function getTrustholderEnrollments(): TrustholderEnrollmentState {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<TrustholderEnrollmentState>
    const list = Array.isArray(parsed.enrollments) ? parsed.enrollments : []
    return {
      enrollments: list.filter(
        (e): e is TrustholderEnrollment =>
          !!e &&
          (e.operator === 'handcash' || e.operator === 'haste') &&
          typeof e.baseUrl === 'string' &&
          typeof e.shareIndex === 'number',
      ),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setTrustholderEnrollments(
  enrollments: TrustholderEnrollment[],
): TrustholderEnrollmentState {
  const next: TrustholderEnrollmentState = {
    enrollments,
    updatedAt: Date.now(),
  }
  durableSetItem(KEY, JSON.stringify(next))
  return next
}

export function upsertTrustholderEnrollment(
  enrollment: TrustholderEnrollment,
): TrustholderEnrollmentState {
  const current = getTrustholderEnrollments()
  const next = current.enrollments.filter((e) => e.operator !== enrollment.operator)
  next.push(enrollment)
  return setTrustholderEnrollments(next)
}

export function getEnrollmentForOperator(
  operator: TrustholderOperator,
): TrustholderEnrollment | null {
  return (
    getTrustholderEnrollments().enrollments.find((e) => e.operator === operator) ?? null
  )
}

export function getTrustholderSharePlan(): TrustholderSharePlan | null {
  try {
    const raw = durableGetItem(PLAN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TrustholderSharePlan>
    if (
      typeof parsed.integrity !== 'string' ||
      !Array.isArray(parsed.shares) ||
      parsed.shares.length < 3 ||
      typeof parsed.threshold !== 'number' ||
      typeof parsed.totalShares !== 'number'
    ) {
      return null
    }
    return {
      integrity: parsed.integrity,
      threshold: parsed.threshold,
      totalShares: parsed.totalShares,
      shares: parsed.shares.map(String),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    }
  } catch {
    return null
  }
}

export function setTrustholderSharePlan(plan: TrustholderSharePlan): void {
  durableSetItem(PLAN_KEY, JSON.stringify(plan))
}

export function clearTrustholderSharePlan(): void {
  durableSetItem(PLAN_KEY, '')
}
