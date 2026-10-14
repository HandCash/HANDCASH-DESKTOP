/**
 * Off-device copy of the custody journal, beside the BRC-39 history object.
 * Sealing, union and conditional push live in `journalReplica.ts`; the journal
 * is a grow-only set, so no device can ever overwrite another's recipes.
 */
import {
  appendCustody,
  custodyEntries,
  custodyJournalRoot,
  onCustodyJournalGrew,
} from './custodyJournal'
import {
  journalReplica,
  openJournal,
  sealJournal,
  type JournalSyncResult,
  type SealedJournal,
} from './journalReplica'
import type { ActiveWallet } from './session'

const HKDF_INFO = 'handcash custody journal v1'

export type CustodySyncResult = JournalSyncResult

const replica = journalReplica({
  object: 'custody.journal',
  info: HKDF_INFO,
  tag: 'custody-journal',
  debounceMs: 15_000,
  root: custodyJournalRoot,
  entries: custodyEntries,
  append: appendCustody,
})

export function sealCustodyJournal(
  rootKeyHex: string,
  identityKey: string,
  root: string,
  entries: readonly unknown[],
): Promise<SealedJournal> {
  return sealJournal(HKDF_INFO, rootKeyHex, identityKey, root, entries)
}

/** Entries of a sealed journal; throws on a foreign or tampered object. */
export function openCustodyJournal(rootKeyHex: string, identityKey: string, sealed: unknown): Promise<unknown[]> {
  return openJournal(HKDF_INFO, rootKeyHex, identityKey, sealed)
}

/** Pull, union, and push when the two sets differ. */
export function syncCustodyJournal(active: ActiveWallet, reason: string): Promise<CustodySyncResult> {
  return replica.sync(active, reason)
}

/** Debounced sync of the current wallet's journal; retries after a failure. */
export function scheduleCustodyJournalSync(reason = 'grew', delayMs?: number): void {
  replica.schedule(reason, delayMs)
}

let stop: (() => void) | null = null

/** Replicate after every growth of the current wallet's journal. */
export function startCustodyJournalBackup(): void {
  if (stop) return
  stop = onCustodyJournalGrew((owner) => replica.scheduleFor(owner))
}

export function resetCustodyJournalBackupForTests(): void {
  replica.reset()
  stop?.()
  stop = null
}
