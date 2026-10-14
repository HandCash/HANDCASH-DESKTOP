import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { vaultLocalKey } from '../vaultLocalKeys'
import type {
  EmailRecoveryEnrollment,
  PendingGoogleRecovery,
} from './types'

const ENROLLMENT_KEY = storageRegistry.emailRecovery.key
const PENDING_KEY = `${storageRegistry.emailRecovery.key}.pending`

function read<T>(key: string): T | null {
  try {
    const raw = durableGetItem(vaultLocalKey(key))
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  durableSetItem(vaultLocalKey(key), value == null ? '' : JSON.stringify(value))
}

export function getEmailRecoveryEnrollment(): EmailRecoveryEnrollment | null {
  const row = read<EmailRecoveryEnrollment>(ENROLLMENT_KEY)
  return row?.v === 1 ? row : null
}

export function setEmailRecoveryEnrollment(
  enrollment: EmailRecoveryEnrollment | null,
): void {
  write(ENROLLMENT_KEY, enrollment)
}

export function getPendingGoogleRecovery(): PendingGoogleRecovery | null {
  return read<PendingGoogleRecovery>(PENDING_KEY)
}

export function setPendingGoogleRecovery(
  pending: PendingGoogleRecovery | null,
): void {
  write(PENDING_KEY, pending)
}
