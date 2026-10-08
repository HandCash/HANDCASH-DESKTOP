/**
 * historyReplica document budget — refuse an unencryptable export instead of
 * killing the renderer with it.
 *
 * Encryption does not stream (`brc39Lean.ts`). For a document of N bytes the
 * worker holds the JSON string, a transient validation parse, one UTF-8
 * plaintext and the sealed output. The toolbox's own `encryptBRC39` held about
 * twenty times N in `number[]` copies, which killed Android WebViews on
 * documents of a few tens of MB and a 254MB document on Desktop.
 *
 * A refusal loses the same backup the crash would have lost, and keeps the
 * wallet. See `layers.ts` (historyReplica).
 */
import { appendAppLog } from './appLog'
import { clearBackupOversize, noteBackupOversize } from './backupWatchdog'

/**
 * Kept well under the observed ~1.7GB worker ceiling: the multiplier above is
 * an estimate, and overshooting it is a renderer kill rather than an error.
 */
export const HISTORY_DOCUMENT_BUDGET_BYTES = 64 * 1024 * 1024

/**
 * Largest encrypted backup the history host stores and a download accepts:
 * BRC-CLOUD's PUT cap, under the Workers 100MB request ceiling. Downloads must
 * keep accepting backups written before the document budget above existed.
 */
export const HISTORY_BACKUP_MAX_BYTES = 96 * 1024 * 1024

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
      )} history backup budget. Reduce the history size before uploading.`,
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
  const bytes = new TextEncoder().encode(json).byteLength
  if (bytes < HISTORY_DOCUMENT_WARN_BYTES) {
    clearBackupOversize()
    return
  }

  const breakdown = formatBrc38TableSizes(summarizeBrc38TableSizes(json))
  if (bytes <= HISTORY_DOCUMENT_BUDGET_BYTES) {
    clearBackupOversize()
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
  noteBackupOversize(bytes)
  throw new HistoryDocumentTooLargeError(bytes)
}
