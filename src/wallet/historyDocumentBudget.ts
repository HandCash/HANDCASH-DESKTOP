/**
 * historyReplica document budget — refuse an unencryptable export instead of
 * killing the renderer with it.
 *
 * `encryptBRC39` does not stream. For a document of N bytes it holds, at once:
 * the canonical string we passed in, the structured-clone copy inside the
 * worker, `JSON.parse` of that, a second canonical string from its own
 * `canonicalize`, a `number[]` from `Utils.toArray` (~8 bytes per byte of
 * document), the `Uint8Array` plaintext, the AES-GCM result, and a final
 * `Array.from` over the whole ciphertext (another ~8x). Peak heap is roughly
 * twenty times the document, so a worker with a ~2GB ceiling cannot encrypt
 * much past 100MB, and a 254MB document dies before Argon2id even starts —
 * taking the unlocked session, and any in-flight settlement, with it.
 *
 * A refusal loses the same backup the crash would have lost, and keeps the
 * wallet. See `layers.ts` (historyReplica).
 */
import { appendAppLog } from './appLog'

/**
 * Kept well under the observed ~1.7GB worker ceiling: the multiplier above is
 * an estimate, and overshooting it is a renderer kill rather than an error.
 */
export const HISTORY_DOCUMENT_BUDGET_BYTES = 64 * 1024 * 1024

/** Growth past this is worth a warning while backups still succeed. */
const HISTORY_DOCUMENT_WARN_BYTES = HISTORY_DOCUMENT_BUDGET_BYTES / 2

/** Tables `exportBRC38` emits, in the order `canonicalize` sorts them. */
const BRC38_TABLES = [
  'certificateFields',
  'certificates',
  'commissions',
  'outputBaskets',
  'outputTagMaps',
  'outputTags',
  'outputs',
  'provenTxReqs',
  'provenTxs',
  'syncStates',
  'transactions',
  'txLabelMaps',
  'txLabels',
] as const

export type Brc38TableSize = { table: string; bytes: number }

export class HistoryDocumentTooLargeError extends Error {
  override readonly name = 'HistoryDocumentTooLargeError'
  constructor(readonly bytes: number) {
    super(
      `BRC-38 document is ${mib(bytes)} — over the ${mib(
        HISTORY_DOCUMENT_BUDGET_BYTES,
      )} history backup budget. Encrypting it would crash the wallet.`,
    )
  }
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Per-table byte spans, largest first.
 *
 * Measured by locating each table key in the canonical document rather than by
 * parsing it — parsing is what we are trying not to do at this size. Keys are
 * searched in sorted order from the previous hit, so a table name that also
 * appears inside row data (provenTxReq history notes carry embedded JSON) can
 * skew attribution. It is precise enough to name a table holding hundreds of
 * megabytes, which is all this is for.
 */
export function summarizeBrc38TableSizes(json: string): Brc38TableSize[] {
  const marks: { table: string; start: number }[] = []
  let from = json.indexOf('"tables":{')
  if (from < 0) from = 0
  for (const table of BRC38_TABLES) {
    const at = json.indexOf(`"${table}":[`, from)
    if (at < 0) continue
    marks.push({ table, start: at })
    from = at
  }
  return marks
    .map((mark, index) => ({
      table: mark.table,
      bytes: (index + 1 < marks.length ? marks[index + 1].start : json.length) - mark.start,
    }))
    .sort((a, b) => b.bytes - a.bytes)
}

export function formatBrc38TableSizes(sizes: Brc38TableSize[]): string {
  return sizes
    .filter((size) => size.bytes > 0)
    .map((size) => `${size.table} ${mib(size.bytes)}`)
    .join(', ')
}

/**
 * Log the document size and refuse anything the encrypt path cannot survive.
 * The breakdown is only computed when it matters — it costs a scan per table.
 */
export function assertHistoryDocumentEncryptable(json: string): void {
  const bytes = json.length
  if (bytes < HISTORY_DOCUMENT_WARN_BYTES) return

  const breakdown = formatBrc38TableSizes(summarizeBrc38TableSizes(json))
  if (bytes <= HISTORY_DOCUMENT_BUDGET_BYTES) {
    appendAppLog(
      'warn',
      `[cloud-backup] BRC-38 document ${mib(bytes)} approaching the ${mib(
        HISTORY_DOCUMENT_BUDGET_BYTES,
      )} budget — ${breakdown}`,
    )
    return
  }

  appendAppLog(
    'error',
    `[cloud-backup] refusing to encrypt ${mib(bytes)} BRC-38 document — ${breakdown}`,
  )
  throw new HistoryDocumentTooLargeError(bytes)
}
