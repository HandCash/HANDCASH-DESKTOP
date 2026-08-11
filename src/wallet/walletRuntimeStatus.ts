/**
 * Live wallet runtime — one place to read “what is the wallet doing right now?”
 * Used by Settings → Statecharts and status-pill tooltips so sync/send races
 * are visible instead of silent.
 */
import { getActivityWriteGeneration, listRecentActivity } from './appActivity'
import { getCloudBackupHealth } from './cloudBackupHealth'
import { getPaymentProgress } from './paymentProgress'
import { describeWalletCoordinator } from './walletCoordinator'
import { getSyncHealth } from './walletHealth'

export type WalletRuntimeStatus = {
  at: number
  coordinator: ReturnType<typeof describeWalletCoordinator>
  syncPhase: string
  syncMessage: string | null
  syncAgeMs: number
  cloudPhase: string
  paymentPhase: string
  paymentDetail: string | null
  activityRows: number
  activityGeneration: number
  summary: string
}

export function getWalletRuntimeStatus(): WalletRuntimeStatus {
  const coordinator = describeWalletCoordinator()
  const sync = getSyncHealth()
  const cloud = getCloudBackupHealth()
  const payment = getPaymentProgress()
  const activityRows = listRecentActivity(200).length
  const activityGeneration = getActivityWriteGeneration()
  const syncAgeMs = sync.updatedAt > 0 ? Math.max(0, Date.now() - sync.updatedAt) : 0

  const bits: string[] = [coordinator.summary]
  bits.push(`sync:${sync.phase}`)
  if (payment.phase !== 'idle') bits.push(`pay:${payment.phase}`)
  if (cloud.phase !== 'off') bits.push(`backup:${cloud.phase}`)
  bits.push(`activity×${activityRows}`)

  return {
    at: Date.now(),
    coordinator,
    syncPhase: sync.phase,
    syncMessage: sync.message,
    syncAgeMs,
    cloudPhase: cloud.phase,
    paymentPhase: payment.phase,
    paymentDetail: payment.detail,
    activityRows,
    activityGeneration,
    summary: bits.join(' · '),
  }
}
