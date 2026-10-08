import { Transaction } from '@bsv/sdk'
import { type ActiveWallet } from './session'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'
import { yieldToUi } from './yieldToUi'

/**
 * An item's locking script is its whole inscription, and the toolbox stores
 * outputs without scripts: `include: 'locking scripts'` on a basket page loads
 * one raw transaction per row inside the single storage lock. A 1,000-card
 * Collect read held that lock for 366s on a phone and every send behind it
 * timed out. Scripts never change per outpoint, so the basket is read bare and
 * only rows this session has not seen are filled here — one transaction per
 * lock hold, so a send waits behind one read, not the whole basket.
 */

export type ScriptRow = { outpoint: string; lockingScript?: string }

export type ScriptFillOutcome = {
  filled: number
  missing: number
  ms: number
  stoppedFor: 'send' | 'stale' | 'budget' | null
  /** Rows the fill stopped before reading — unknown for now, not for good. */
  unread: Set<ScriptRow>
}

const OUTPOINT_RE = /^([0-9a-f]{64})[._](\d+)$/i
const READ_TIMEOUT_MS = 8_000
export const SCRIPT_FILL_BUDGET_MS = 15_000

type RawTxStorage = {
  getProvenOrRawTx(txid: string): Promise<{ proven?: { rawTx?: number[] }; rawTx?: number[] } | undefined>
}

type StorageManager = {
  isActiveStorageProvider?: () => boolean
  runAsStorageProvider?: <T>(fn: (sp: RawTxStorage) => Promise<T>) => Promise<T>
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const m = OUTPOINT_RE.exec(outpoint.trim())
  return m ? { txid: m[1]!.toLowerCase(), vout: Number(m[2]) } : null
}

async function readRawTx(storage: StorageManager, txid: string): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      storage.runAsStorageProvider!(async (sp) => {
        const row = await sp.getProvenOrRawTx(txid)
        const bytes = row?.proven?.rawTx ?? row?.rawTx
        return Array.isArray(bytes) && bytes.length > 0 ? bytes : null
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Give each row a script: carried from `known`, else read from its local transaction. */
export async function fillItemScripts(
  wallet: ActiveWallet['wallet'],
  rows: ScriptRow[],
  opts: {
    known: ReadonlyMap<string, string>
    keyOf: (outpoint: string) => string
    stillCurrent: () => boolean
    budgetMs?: number
  },
): Promise<ScriptFillOutcome> {
  const startedAt = Date.now()
  const byTxid = new Map<string, { row: ScriptRow; vout: number }[]>()
  for (const row of rows) {
    if (row.lockingScript) continue
    const carried = opts.known.get(opts.keyOf(row.outpoint))
    if (carried) {
      row.lockingScript = carried
      continue
    }
    const parts = splitOutpoint(row.outpoint)
    if (!parts) continue
    const group = byTxid.get(parts.txid) ?? []
    group.push({ row, vout: parts.vout })
    byTxid.set(parts.txid, group)
  }
  const outcome: ScriptFillOutcome = {
    filled: 0,
    missing: 0,
    ms: 0,
    stoppedFor: null,
    unread: new Set(),
  }
  const storage = (wallet as { storage?: StorageManager }).storage
  const readable =
    !!storage?.runAsStorageProvider && storage.isActiveStorageProvider?.() !== false
  const budgetMs = opts.budgetMs ?? SCRIPT_FILL_BUDGET_MS
  for (const [txid, group] of byTxid) {
    if (!readable) break
    if (!outcome.stoppedFor) {
      if (!opts.stillCurrent()) outcome.stoppedFor = 'stale'
      else if (shouldYieldChainIngestToSpend()) outcome.stoppedFor = 'send'
      else if (Date.now() - startedAt > budgetMs) outcome.stoppedFor = 'budget'
    }
    if (outcome.stoppedFor) {
      for (const { row } of group) outcome.unread.add(row)
      continue
    }
    const raw = await readRawTx(storage!, txid)
    if (raw) {
      try {
        const tx = Transaction.fromBinary(raw)
        for (const { row, vout } of group) {
          const hex = tx.outputs[vout]?.lockingScript?.toHex()
          if (hex) {
            row.lockingScript = hex
            outcome.filled++
          }
        }
      } catch {
        // An unparseable body leaves the rows unknown, as an omitted script does.
      }
    }
    await yieldToUi()
  }
  for (const group of byTxid.values()) {
    for (const { row } of group) if (!row.lockingScript) outcome.missing++
  }
  outcome.ms = Date.now() - startedAt
  return outcome
}
