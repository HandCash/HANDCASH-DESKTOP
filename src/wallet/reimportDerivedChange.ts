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
  rememberDerivedChangeFromRows,
  type DerivedChangeEcho,
} from './derivedChangeEcho'
import { withVisibleOnChainBeef } from './legacyBeef'
import { parseOutpoint } from './legacyScan'
import { withRestoredInternalizeStatus } from './peerIngestHelpers'

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
    const part = await reimportTx(txid, vouts)
    result.imported += part.imported
    result.skipped += part.skipped
    result.failed += part.failed
  }
  return result
}
