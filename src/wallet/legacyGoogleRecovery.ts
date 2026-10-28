/**
 * The record a wallet saved when it enrolled in Google recovery, now retired.
 * Nothing creates one any more, but enrolled users still have a share with the
 * old holder and one in their inbox, so the record is kept, read safely and
 * passed to new devices until those users move to another recovery method.
 */
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { vaultLocalKey } from './vaultLocalKeys'

export type LegacyGoogleEnrollment = {
  v: 1
  host: string
  email: string
  authorityKey: string
  attesterKey: string
  master: { derivation: 'brc-42' } | { derivation: 'brc-157'; entropyLength: number }
  mailboxConfirmed: boolean
  enrolledAt: number
}

const ENROLLMENT_KEY = storageRegistry.emailRecovery.key

export function getLegacyGoogleEnrollment(): LegacyGoogleEnrollment | null {
  try {
    const raw = durableGetItem(vaultLocalKey(ENROLLMENT_KEY))
    const row = raw ? (JSON.parse(raw) as LegacyGoogleEnrollment) : null
    return row?.v === 1 ? row : null
  } catch {
    return null
  }
}

export function setLegacyGoogleEnrollment(enrollment: LegacyGoogleEnrollment | null): void {
  durableSetItem(vaultLocalKey(ENROLLMENT_KEY), enrollment == null ? '' : JSON.stringify(enrollment))
}
