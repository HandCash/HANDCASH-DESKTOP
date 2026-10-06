import { getActiveWallet } from './session'

/**
 * Re-create toolbox rows for wallet-owned outputs whose IndexedDB row is gone.
 *
 * Reclaim can only `updateOutput`. These coins need `internalizeAction` with
 * the recipe the custody journal holds — a self wallet-payment for derived
 * change, a basket insertion for basket outputs — not a second
 * `importLegacyUtxos` sweep (that path signs with the identity P2PKH key and
 * cannot unlock BRC-29 change). The journal is the one recovery path; these
 * entry points keep their historical names for the callers.
 */
import { pinAccountKeyScope } from './accountLocalKeys'
import { journalAllToolboxOutputs } from './custodyJournalCapture'
import { recoverFromCustodyJournal, reimportJournaledOutpoints } from './custodyJournalRecovery'
import { rememberDerivedChangeFromRows, type DerivedChangeRow } from './derivedChangeEcho'
import type { ActiveWallet } from './session'
import { getWalletRuntime } from './walletRuntime'

export type ReimportDerivedChangeResult = {
  imported: number
  skipped: number
  failed: number
}

/**
 * Re-import outpoints the caller proved unspent on chain with no toolbox row.
 * Requires a journal recipe; otherwise fails closed.
 */
export async function reimportDerivedChangeOutpoints(
  outpoints: string[],
  owner?: ActiveWallet,
): Promise<ReimportDerivedChangeResult> {
  const unique = [...new Set(outpoints.map((op) => op.trim()).filter(Boolean))]
  const active = owner ?? getActiveWallet()
  if (!active || unique.length === 0) return { imported: 0, skipped: unique.length, failed: 0 }
  return reimportJournaledOutpoints(active, unique)
}

/** Echo files and reimports resolve against the bound account, not the argument. */
function isCurrentWallet(active: ActiveWallet): boolean {
  return getWalletRuntime()?.instance === active
}

const ECHO_PAGE = 500
const ECHO_MAX_PAGES = 40

/** Every output row, spendable or not, without scripts. */
async function readAllOutputRows(active: ActiveWallet): Promise<DerivedChangeRow[]> {
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return []
  const rows: DerivedChangeRow[] = []
  try {
    await storage.runAsStorageProvider(async (sp) => {
      const provider = sp as { findOutputs?: (args: unknown) => Promise<unknown> }
      if (typeof provider.findOutputs !== 'function') return
      for (const spendable of [true, false]) {
        for (let page = 0; page < ECHO_MAX_PAGES; page += 1) {
          const batch = await provider.findOutputs({
            partial: { spendable },
            noScript: true,
            paged: { limit: ECHO_PAGE, offset: page * ECHO_PAGE },
          })
          if (!Array.isArray(batch) || batch.length === 0) break
          rows.push(...(batch as DerivedChangeRow[]))
          if (batch.length < ECHO_PAGE) break
        }
      }
    })
  } catch (err) {
    console.warn('[derived-change] output read failed', err)
  }
  return rows
}

/**
 * Journal the recipe of every output this toolbox still knows, spent or not;
 * returns how many recipes were new.
 *
 * Call before anything replaces localState wholesale. A snapshot older than
 * the live store cannot hold the change made since, and that change is only
 * spendable through its random prefix/suffix — which lives in the rows about
 * to be wiped (hc-a580a, 2026-09-30: a History restore of a week-old backup
 * replaced 1,007,412 live sats with 4.3M sats of long-spent coins).
 */
export async function echoAllDerivedOutputs(active: ActiveWallet): Promise<number> {
  const t0 = Date.now()
  const owner = pinAccountKeyScope(active)
  const journaled = owner ? (await journalAllToolboxOutputs(active.wallet, owner)).added : 0
  const rows = await readAllOutputRows(active)
  // The echo file resolves against the bound account, not `active`.
  if (!isCurrentWallet(active)) return journaled
  const added = rememberDerivedChangeFromRows(rows)
  console.info(
    `[derived-change] echoed ${added} derivation(s), journaled ${journaled} recipe(s) from ${rows.length} output row(s) done ${Date.now() - t0}ms`,
  )
  return journaled
}

export type EchoRecoveryResult = ReimportDerivedChangeResult & {
  checked: number
  spent: number
  unknown: number
}

/**
 * Re-import every journaled output that is unspent on chain but has no
 * toolbox row. Spends are journaled; unanswered probes back off.
 */
export async function recoverEchoedChange(
  active: ActiveWallet | null = getWalletRuntime()?.instance ?? null,
): Promise<EchoRecoveryResult> {
  const r = await recoverFromCustodyJournal(active)
  return {
    imported: r.imported,
    skipped: 0,
    failed: r.failed,
    checked: r.checked,
    spent: r.spent,
    unknown: r.unknown,
  }
}
