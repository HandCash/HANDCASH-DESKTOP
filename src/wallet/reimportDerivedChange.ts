import { getActiveWallet } from './session'

/**
 * Re-create toolbox rows for wallet-owned derived change whose IndexedDB
 * row is gone but whose BRC-29 remittance we still have.
 *
 * Reclaim can only `updateOutput`. These coins need `internalizeAction` as a
 * self wallet-payment — the same shape as consolidating change back into the
 * basket — not a second `importLegacyUtxos` sweep (that path signs with the
 * identity P2PKH key and cannot unlock BRC-29 change).
 */
import { getBeefForTxidCached } from './beefCache'
import {
  derivedChangeEchoFor,
  forgetDerivedChange,
  listDerivedChangeEcho,
  rememberDerivedChangeFromRows,
  type DerivedChangeEcho,
  type DerivedChangeRow,
} from './derivedChangeEcho'
import type { ActiveWallet } from './session'
import { withVisibleOnChainBeef } from './legacyBeef'
import { parseOutpoint } from './legacyScan'
import { withRestoredInternalizeStatus } from './peerIngestHelpers'
import { getWalletRuntime } from './walletRuntime'

import { creditUtxo, releaseConsumedUtxo } from './utxoLockManager'

export type ReimportDerivedChangeResult = {
  imported: number
  skipped: number
  failed: number
}

function groupByTxid(outpoints: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (const raw of outpoints) {
    const parsed = parseOutpoint(raw)
    if (!parsed) continue
    const list = groups.get(parsed.txid)
    if (list) {
      if (!list.includes(parsed.vout)) list.push(parsed.vout)
    } else groups.set(parsed.txid, [parsed.vout])
  }
  return groups
}

async function toolboxHasOutput(
  txid: string,
  vout: number,
): Promise<boolean> {
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return false
  try {
    return (await storage.runAsStorageProvider(async (sp) => {
      const provider = sp as {
        findOutputs?: (args: unknown) => Promise<unknown>
        findTransactions?: (
          args: unknown,
        ) => Promise<Array<{ transactionId?: number }> | undefined>
      }
      if (typeof provider.findOutputs !== 'function') return false
      const matchVout = (
        rows: Array<{ vout?: number; outputIndex?: number }> | undefined,
      ) =>
        (rows ?? []).some(
          (row) => Number(row.vout ?? row.outputIndex) === vout,
        )
      const direct = await provider.findOutputs({
        partial: { txid },
        paged: { limit: 50, offset: 0 },
      })
      if (matchVout(Array.isArray(direct) ? direct : [])) return true
      if (typeof provider.findTransactions !== 'function') return false
      const txRows = await provider.findTransactions({
        partial: { txid },
        noRawTx: true,
        paged: { limit: 1, offset: 0 },
      })
      const transactionId = Number(txRows?.[0]?.transactionId)
      if (!Number.isFinite(transactionId) || transactionId <= 0) return false
      const linked = await provider.findOutputs({
        partial: { transactionId },
        paged: { limit: 50, offset: 0 },
      })
      return matchVout(Array.isArray(linked) ? linked : [])
    })) as boolean
  } catch {
    return false
  }
}

async function reimportTx(
  txid: string,
  vouts: number[],
): Promise<{ imported: number; skipped: number; failed: number }> {
  const active = getActiveWallet()
  if (!active) return { imported: 0, skipped: vouts.length, failed: 0 }

  const echoes: DerivedChangeEcho[] = []
  const missingRemittance: number[] = []
  for (const vout of vouts) {
    if (await toolboxHasOutput(txid, vout)) continue
    const echo = derivedChangeEchoFor(`${txid}.${vout}`)
    if (!echo) {
      missingRemittance.push(vout)
      continue
    }
    echoes.push(echo)
  }

  let skipped = missingRemittance.length
  if (missingRemittance.length > 0) {
    console.warn(
      `[derived-change] ${txid.slice(0, 12)}… ${missingRemittance.length} output(s) live on chain with no toolbox row and no remittance echo — cannot re-import`,
      missingRemittance,
    )
  }
  if (echoes.length === 0) {
    return { imported: 0, skipped, failed: 0 }
  }

  const beef = await getBeefForTxidCached(active, txid, {
    allowUnprovenRawTx: true,
    needProof: true,
  })
  const atomic = Array.from(beef.toBinaryAtomic(txid))
  if (atomic.length === 0) {
    console.warn(`[derived-change] no BEEF for ${txid.slice(0, 12)}…`)
    return { imported: 0, skipped, failed: echoes.length }
  }

  try {
    await withRestoredInternalizeStatus(txid, () =>
      withVisibleOnChainBeef(() =>
        active.wallet.internalizeAction({
          tx: atomic,
          description: 'Reimport derived change',
          labels: ['handcash-reimport-change'],
          outputs: echoes.map((echo) => ({
            outputIndex: echo.vout,
            protocol: 'wallet payment' as const,
            paymentRemittance: {
              derivationPrefix: echo.derivationPrefix,
              derivationSuffix: echo.derivationSuffix,
              senderIdentityKey: echo.senderIdentityKey || active.identityKey,
            },
          })),
          seekPermission: false,
        }),
      ),
    )
  } catch (err) {
    console.warn(`[derived-change] internalize ${txid.slice(0, 12)}… failed`, err)
    return { imported: 0, skipped, failed: echoes.length }
  }

  rememberDerivedChangeFromRows(echoes)
  for (const echo of echoes) {
    const outpoint = `${echo.txid}.${echo.vout}`
    releaseConsumedUtxo(outpoint, 'reimport:derived-change')
    creditUtxo(outpoint, { satoshis: echo.satoshis })
  }
  console.info(
    `[derived-change] re-imported ${echoes.length} output(s) of ${txid.slice(0, 12)}…`,
  )
  return { imported: echoes.length, skipped, failed: 0 }
}

/**
 * Re-import derived change for outpoints that are unspent on chain but have
 * no toolbox row. Requires a remittance echo; otherwise fails closed.
 */
export async function reimportDerivedChangeOutpoints(
  outpoints: string[],
  owner?: ActiveWallet,
): Promise<ReimportDerivedChangeResult> {
  const unique = [...new Set(outpoints.map((op) => op.trim()).filter(Boolean))]
  const groups = groupByTxid(unique)
  const result: ReimportDerivedChangeResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
  }
  if (groups.size === 0) {
    result.skipped = unique.length
    return result
  }
  for (const [txid, vouts] of groups) {
    if (owner && !isCurrentWallet(owner)) {
      result.skipped += vouts.length
      continue
    }
    const part = await reimportTx(txid, vouts)
    result.imported += part.imported
    result.skipped += part.skipped
    result.failed += part.failed
  }
  return result
}

/** Echo files and reimports resolve against the bound account, not the argument. */
function isCurrentWallet(active: ActiveWallet): boolean {
  return getWalletRuntime()?.instance === active
}

const ECHO_PAGE = 500
const ECHO_MAX_PAGES = 40
/** Largest absent echoes probed per pass; the rest wait for the next one. */
const RECOVERY_PROBE_MAX = 400

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
 * Echo the derivation of every output this toolbox still knows, spent or not.
 *
 * Call before anything replaces localState wholesale. A snapshot older than
 * the live store cannot hold the change made since, and that change is only
 * spendable through its random prefix/suffix — which lives in the rows about
 * to be wiped (hc-a580a, 2026-09-30: a History restore of a week-old backup
 * replaced 1,007,412 live sats with 4.3M sats of long-spent coins).
 */
export async function echoAllDerivedOutputs(active: ActiveWallet): Promise<number> {
  const t0 = Date.now()
  const rows = await readAllOutputRows(active)
  // The echo file resolves against the bound account, not `active`.
  if (!isCurrentWallet(active)) return 0
  const added = rememberDerivedChangeFromRows(rows)
  console.info(
    `[derived-change] echoed ${added} derivation(s) from ${rows.length} output row(s) done ${Date.now() - t0}ms`,
  )
  return added
}

export type EchoRecoveryResult = ReimportDerivedChangeResult & {
  checked: number
  spent: number
  unknown: number
}

/**
 * Re-import every echoed coin that is unspent on chain but has no toolbox row.
 * Spent echoes are forgotten; unanswered ones stay for the next pass.
 */
export async function recoverEchoedChange(
  active: ActiveWallet | null = getWalletRuntime()?.instance ?? null,
): Promise<EchoRecoveryResult> {
  const result: EchoRecoveryResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    checked: 0,
    spent: 0,
    unknown: 0,
  }
  if (!active || !isCurrentWallet(active)) return result
  const t0 = Date.now()
  const rows = await readAllOutputRows(active)
  if (!isCurrentWallet(active)) return result
  const held = new Set<string>()
  for (const row of rows) {
    const txid = String(row.txid ?? '').toLowerCase()
    const vout = Number(row.vout ?? row.outputIndex)
    if (/^[0-9a-f]{64}$/.test(txid) && Number.isInteger(vout)) held.add(`${txid}.${vout}`)
  }
  const absent = listDerivedChangeEcho()
    .filter((echo) => !held.has(`${echo.txid}.${echo.vout}`))
    .sort((a, b) => b.satoshis - a.satoshis)
    .slice(0, RECOVERY_PROBE_MAX)
    .map((echo) => `${echo.txid}.${echo.vout}`)
  result.checked = absent.length
  if (absent.length === 0) return result

  const { probeOutpointSpends } = await import('./createActionInputFate')
  const probes = await probeOutpointSpends(absent, '', active.chain)
  if (!isCurrentWallet(active)) return result
  const live: string[] = []
  const dead: string[] = []
  for (const outpoint of absent) {
    const probe = probes.get(outpoint)
    if (probe?.kind === 'unspent') live.push(outpoint)
    else if (probe?.kind === 'spent') dead.push(outpoint)
    else result.unknown += 1
  }
  result.spent = forgetDerivedChange(dead)
  if (live.length > 0) {
    const reimported = await reimportDerivedChangeOutpoints(live, active)
    result.imported = reimported.imported
    result.skipped = reimported.skipped
    result.failed = reimported.failed
  }
  const sats = live.reduce((sum, op) => sum + (derivedChangeEchoFor(op)?.satoshis ?? 0), 0)
  console.info(
    `[derived-change] echo recovery checked=${result.checked} live=${live.length} sats=${sats} ` +
      `imported=${result.imported} failed=${result.failed} spent=${result.spent} unknown=${result.unknown} ` +
      `done ${Date.now() - t0}ms`,
  )
  return result
}
