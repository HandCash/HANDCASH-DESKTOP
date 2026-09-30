/**
 * The spends recorded in a decrypted BRC-38 history document.
 *
 * Runs inside `brc39.worker.ts`, so only this summary — never the document —
 * crosses to the UI thread. A transaction's inputs come from its body (the
 * transaction row, else its proven row) and from every output row it spent,
 * so a proven tx whose body moved tables still names what it consumed.
 */
import { Utils } from '@bsv/sdk'
import { inputOutpointsFromRawTx } from './txOutpoints'

export type PeerSnapshotTx = {
  txid: string
  status: string
  /** Empty for `failed` / `unsigned` rows — they spend nothing. */
  inputs: string[]
}

export type PeerSnapshot = {
  storageIdentityKey: string | null
  txs: PeerSnapshotTx[]
}

type Row = Record<string, unknown>

const TXID_RE = /^[0-9a-f]{64}$/
const SPENDS_NOTHING: ReadonlySet<string> = new Set(['failed', 'unsigned'])

function rows(tables: unknown, name: string): Row[] {
  const list = tables && typeof tables === 'object' ? (tables as Row)[name] : null
  return Array.isArray(list) ? (list.filter((r) => r && typeof r === 'object') as Row[]) : []
}

function bytes(value: unknown): number[] | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const out = Utils.toArray(value, 'base64')
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

function id(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function peerSnapshotFromBrc38(doc: unknown): PeerSnapshot {
  const data = (doc && typeof doc === 'object' ? doc : {}) as Row
  const settings = (data.sourceStorage ?? {}) as Row
  const storageIdentityKey =
    typeof settings.storageIdentityKey === 'string' && settings.storageIdentityKey
      ? settings.storageIdentityKey
      : null

  const provenRaw = new Map<number, number[]>()
  for (const row of rows(data.tables, 'provenTxs')) {
    const key = id(row.provenTxId)
    const raw = bytes(row.rawTx)
    if (key != null && raw) provenRaw.set(key, raw)
  }

  const spentByTx = new Map<number, string[]>()
  for (const row of rows(data.tables, 'outputs')) {
    const spender = id(row.spentBy)
    const txid = String(row.txid ?? '').toLowerCase()
    const vout = Number(row.vout)
    if (spender == null || !TXID_RE.test(txid) || !Number.isInteger(vout) || vout < 0) continue
    const list = spentByTx.get(spender) ?? []
    list.push(`${txid}.${vout}`)
    spentByTx.set(spender, list)
  }

  const txs: PeerSnapshotTx[] = []
  for (const row of rows(data.tables, 'transactions')) {
    const txid = String(row.txid ?? '').toLowerCase()
    if (!TXID_RE.test(txid)) continue
    const status = String(row.status ?? '').toLowerCase()
    if (SPENDS_NOTHING.has(status)) {
      txs.push({ txid, status, inputs: [] })
      continue
    }
    const inputs = new Set<string>()
    const raw = bytes(row.rawTx) ?? provenRaw.get(id(row.provenTxId) ?? -1) ?? null
    if (raw) for (const outpoint of inputOutpointsFromRawTx(raw)) inputs.add(outpoint)
    for (const outpoint of spentByTx.get(id(row.transactionId) ?? -1) ?? []) inputs.add(outpoint)
    txs.push({ txid, status, inputs: [...inputs] })
  }
  return { storageIdentityKey, txs }
}
