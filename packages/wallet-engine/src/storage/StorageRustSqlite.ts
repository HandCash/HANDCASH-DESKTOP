import { type ValidListActionsArgs, type ValidListOutputsArgs } from '@bsv/sdk/wallet/validationHelpers'
import { Beef, ListActionsResult, ListOutputsResult, WalletOutput } from '@bsv/sdk'
import {
  TableCertificate,
  TableCertificateField,
  TableCertificateX,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from './schema/tables'
import { TableActionBatch, TableActionBatchBlob, TableActionBatchOutput } from './schema/tables/TableActionBatch'
import { StorageAdminStats, StorageProvider, StorageProviderOptions } from './StorageProvider'
import type { StorageIdb } from './StorageIdb'
import { DBType } from './StorageReader'
import { listActionsIdb } from './methods/listActionsIdb'
import { listOutputsIdb, type ListOutputsResume, type ListOutputsResumeResult } from './methods/listOutputsIdb'
import { getListOutputsSpecOp } from './methods/ListOutputsSpecOp'
import { reviewStatusIdb } from './methods/reviewStatusIdb'
import type { CashSummaryPage } from './methods/cashSummaryIdb'
import {
  AuthId,
  FindCertificateFieldsArgs,
  FindCertificatesArgs,
  FindCommissionsArgs,
  FindForUserSincePagedArgs,
  FindMonitorEventsArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindOutputTagMapsArgs,
  FindOutputTagsArgs,
  FindProvenTxReqsArgs,
  FindProvenTxsArgs,
  FindSyncStatesArgs,
  FindTransactionsArgs,
  FindTxLabelMapsArgs,
  FindTxLabelsArgs,
  FindUsersArgs,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  TrxToken,
  WalletStorageProvider
} from '../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { EntityTimeStamp, TransactionStatus } from '../sdk/types'
import { verifyId, verifyOneOrNone } from '../utility/utilityHelpers'
import type { Brc177NoSendExpiryState } from '../utility/brc177NoSendExpiry'

export interface ToolboxDbBridge {
  call: <T = unknown>(dbName: string, op: string, params?: Record<string, unknown>) => Promise<T>
}

export interface StorageRustSqliteOptions extends StorageProviderOptions {
  /** Optional explicit bridge override (defaults to `window.handcash.toolboxDb`). */
  bridge?: ToolboxDbBridge
}

interface RustSqliteTrxToken {
  readonly __rustSqliteTrxId: number
}

interface OpenResponse {
  settings: Record<string, unknown> | null
  migratedFromIdb: boolean
  counts: Record<string, number>
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(input: number[] | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input)
  if (typeof btoa === 'function') {
    const chunk = 0x8000
    const parts: string[] = []
    for (let i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]))
    }
    return btoa(parts.join(''))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += BASE64_CHARS[b0 >> 2]
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '='
  }
  return out
}

function base64ToUint8Array(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array(0)
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const clean = b64.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]!)
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]!)
    const c2 = i + 2 < clean.length ? BASE64_CHARS.indexOf(clean[i + 2]!) : 0
    const c3 = i + 3 < clean.length ? BASE64_CHARS.indexOf(clean[i + 3]!) : 0
    out[p++] = (c0 << 2) | (c1 >> 4)
    if (i + 2 < clean.length) out[p++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (i + 3 < clean.length) out[p++] = ((c2 & 3) << 6) | c3
  }
  return out
}

function base64ToNumberArray(b64: string): number[] {
  return Array.from(base64ToUint8Array(b64))
}

function isBinaryValue(val: unknown): val is Uint8Array | number[] {
  if (val instanceof Uint8Array) return true
  if (Array.isArray(val) && (val.length === 0 || Number.isInteger(val[0]))) return true
  return false
}

function toIsoDate(val: unknown): string | undefined {
  if (val == null) return undefined
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'string' && val.length > 0) return val
  if (typeof val === 'number' && Number.isFinite(val)) return new Date(val).toISOString()
  return undefined
}

const BINARY_WIRE_KEYS: Record<string, string> = {
  lockingScript: 'lockingScriptB64',
  rawTx: 'rawTxB64',
  inputBEEF: 'inputBEEFB64',
  merklePath: 'merklePathB64',
  noSendExpiryReclaimRawTx: 'noSendExpiryReclaimRawTxB64',
  bytes: 'bytesB64'
}

const B64_TO_FIELD: Record<string, string> = {
  lockingScriptB64: 'lockingScript',
  rawTxB64: 'rawTx',
  inputBEEFB64: 'inputBEEF',
  merklePathB64: 'merklePath',
  noSendExpiryReclaimRawTxB64: 'noSendExpiryReclaimRawTx',
  bytesB64: 'bytes'
}

function serializeForWire(
  input: Record<string, unknown>,
  preserveExplicitUndefinedAsNull: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(input)) {
    if (key === 'logger') continue
    const val = input[key]
    if (val === undefined) {
      if (preserveExplicitUndefinedAsNull) {
        const b64Key = BINARY_WIRE_KEYS[key]
        out[b64Key ?? key] = null
      }
      continue
    }
    if (val === null) {
      const b64Key = BINARY_WIRE_KEYS[key]
      out[b64Key ?? key] = null
      continue
    }
    if (val instanceof Date) {
      out[key] = val.toISOString()
      continue
    }
    const b64Key = BINARY_WIRE_KEYS[key]
    if (b64Key != null && isBinaryValue(val)) {
      out[b64Key] = bytesToBase64(val)
      continue
    }
    if (key === 'fields' && Array.isArray(val)) {
      out[key] = val.map(f => serializeForWire(f as Record<string, unknown>, false))
      continue
    }
    out[key] = val
  }
  return out
}

function serializePartialForWire(partial: Record<string, unknown> | undefined): Record<string, unknown> {
  if (partial == null) return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(partial)) {
    const val = partial[key]
    if (val === undefined) continue
    if (val instanceof Date) out[key] = val.toISOString()
    else out[key] = val
  }
  return out
}

function extractTrxId(trx?: TrxToken): number | undefined {
  if (trx == null || typeof trx !== 'object') return undefined
  const id = (trx as Partial<RustSqliteTrxToken>).__rustSqliteTrxId
  return typeof id === 'number' && id > 0 ? id : undefined
}

export function getGlobalToolboxDbBridge(): ToolboxDbBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as unknown as { handcash?: { toolboxDb?: ToolboxDbBridge } }).handcash?.toolboxDb
  return typeof bridge?.call === 'function' ? bridge : undefined
}

/**
 * Native Rust SQLite WAL `StorageProvider` for HandCash Desktop.
 *
 * Replaces WebKitGTK IndexedDB (`StorageIdb`) with bundled `rusqlite` in WAL mode,
 * a 4-connection concurrent `ReaderPool`, and SHA-256 deduplicated `cold_blobs`
 * keeping large scripts / rawTx / inputBEEF / merklePath off hot index pages.
 */
export class StorageRustSqlite extends StorageProvider implements WalletStorageProvider {
  /** Signals `WalletStorageManager` to allow concurrent readers against the SQLite WAL ReadPool. */
  readonly supportsConcurrentReads = true

  dbName: string
  private readonly bridge: ToolboxDbBridge
  private openInfo?: OpenResponse
  private cashSummaryRevision = 0
  private cashSummaryWrites = 0

  constructor(options: StorageRustSqliteOptions) {
    super(options)
    const bridge = options.bridge ?? getGlobalToolboxDbBridge()
    if (bridge == null) {
      throw new WERR_INVALID_OPERATION('Native Rust SQLite toolboxDb bridge is unavailable')
    }
    this.bridge = bridge
    this.dbName = `wallet-toolbox-${this.chain}net`
  }

  protected override supportsActionBatchPersistence(): boolean {
    return true
  }

  protected override supportsNoSendExpiryPersistence(): boolean {
    return true
  }

  protected override requiresActionBatchCleanupBeforeCreateAction(): boolean {
    return false
  }

  private async call<T = unknown>(op: string, params?: Record<string, unknown>, trx?: TrxToken): Promise<T> {
    const trxId = extractTrxId(trx)
    const payload = trxId != null ? { ...(params ?? {}), trxId } : (params ?? {})
    this.whenLastAccess = new Date()
    return await this.bridge.call<T>(this.dbName, op, payload)
  }

  private async writeCall<T = unknown>(op: string, params?: Record<string, unknown>, trx?: TrxToken): Promise<T> {
    const standalone = trx == null
    if (standalone) {
      this.cashSummaryRevision++
      this.cashSummaryWrites++
    }
    this.isDirty = true
    try {
      return await this.call<T>(op, params, trx)
    } finally {
      if (standalone) {
        this.cashSummaryRevision++
        this.cashSummaryWrites--
      }
    }
  }

  async ensureConnectionReady(): Promise<void> {
    if (this._settings == null) {
      await this.readSettings()
    }
  }

  getCashSummaryRevision(): number {
    if (this.cashSummaryWrites > 0) throw new WERR_INVALID_OPERATION('Cash summary is changing')
    return this.cashSummaryRevision
  }

  async readCashSummaryPage(identityKey: string, after = 0, revision?: number): Promise<CashSummaryPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new WERR_INVALID_OPERATION('Invalid summary cursor')
    const current = this.getCashSummaryRevision()
    if (revision != null && current !== revision) throw new WERR_INVALID_OPERATION('Cash summary changed')
    const page = await this.call<{ sats: number; outputCount: number; rowCount: number; next: number | null }>(
      'readCashSummary',
      { identityKey }
    )
    if (this.getCashSummaryRevision() !== current) throw new WERR_INVALID_OPERATION('Cash summary changed')
    return { ...page, revision: current }
  }

  validateCashSummaryRevision(revision: number): void {
    if (this.getCashSummaryRevision() !== revision) throw new WERR_INVALID_OPERATION('Cash summary changed')
  }

  async readPendingChangePage(
    identityKey: string,
    after: number
  ): Promise<{ outputs: TableOutput[]; next: number | null }> {
    if (!Number.isSafeInteger(after) || after < 0) throw new WERR_INVALID_OPERATION('Invalid pending-change cursor')
    const res = await this.call<{ outputs: Record<string, unknown>[]; next: number | null }>(
      'readPendingChangePage',
      { identityKey, after }
    )
    return {
      outputs: res.outputs.map(row => this.hydrateRow<TableOutput>(row)),
      next: res.next
    }
  }

  async purgeRetiredProofRequestsNative(cutoffMs: number): Promise<{ purged: number; bytes: number }> {
    return await this.writeCall<{ purged: number; bytes: number }>('purgeRetiredProofReqs', {
      cutoff: new Date(cutoffMs).toISOString()
    })
  }

  getLastOpenInfo(): OpenResponse | undefined {
    return this.openInfo
  }

  async reloadSettings(): Promise<TableSettings> {
    const raw = await this.call<Record<string, unknown> | null>('readSettings')
    if (raw == null) throw new WERR_INVALID_OPERATION('migrate must be called before first access')
    this._settings = this.hydrateRow<TableSettings>(raw)
    return this._settings
  }

  async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    if (storageName !== '') this.dbName = storageName
    const res = await this.call<OpenResponse>('open', {
      storageName: storageName || this.dbName,
      storageIdentityKey,
      chain: this.chain,
      maxOutputScript: 1024
    })
    this.openInfo = res
    if (res.settings != null) {
      this._settings = this.hydrateRow<TableSettings>(res.settings)
    }
    return '1'
  }

  async readSettings(trx?: TrxToken): Promise<TableSettings> {
    if (this._settings != null && trx == null) return this._settings
    const raw = await this.call<Record<string, unknown> | null>('readSettings', {}, trx)
    if (raw == null) throw new WERR_INVALID_OPERATION('migrate must be called before first access')
    const settings = this.hydrateRow<TableSettings>(raw)
    this._settings = settings
    return settings
  }

  async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType> {
    this._settings ??= await this.readSettings(trx)
    return this._settings.dbtype
  }

  async destroy(): Promise<void> {
    await this.call('close').catch(() => {})
    this._settings = undefined
    this.openInfo = undefined
  }

  async dropAllData(): Promise<void> {
    await this.writeCall('dropAllData')
    this._settings = undefined
    this.openInfo = undefined
  }

  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (trx != null) return await scope(trx)
    this.cashSummaryRevision++
    this.cashSummaryWrites++
    const { trxId } = await this.call<{ trxId: number }>('beginTx')
    const token: RustSqliteTrxToken = { __rustSqliteTrxId: trxId }
    try {
      const result = await scope(token as unknown as TrxToken)
      await this.call('commitTx', { trxId })
      return result
    } catch (err) {
      await this.call('rollbackTx', { trxId }).catch(() => {})
      throw err
    } finally {
      this.cashSummaryRevision++
      this.cashSummaryWrites--
    }
  }

  private assertNoUndefinedInPartial(partial: Record<string, unknown> | undefined): void {
    if (partial == null) return
    for (const k of Object.keys(partial)) {
      if (partial[k] === undefined) {
        throw new WERR_INVALID_PARAMETER(
          `args.partial.${k}`,
          'not undefined. Passing undefined as a filter value is not supported — omit the key to skip filtering. Matches Knex semantics.'
        )
      }
    }
  }

  /** Hydrate wire JSON row (`*B64`, ISO dates) into typed Toolbox entity (`number[]`, `Date`). */
  private hydrateRow<T>(
    raw: Record<string, unknown>,
    dateFields?: string[],
    asUint8ArrayFields?: string[]
  ): T {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(raw)) {
      const val = raw[key]
      if (val === null || val === undefined) continue
      const binTarget = B64_TO_FIELD[key]
      if (binTarget != null && typeof val === 'string') {
        out[binTarget] =
          asUint8ArrayFields?.includes(binTarget) === true ? base64ToUint8Array(val) : base64ToNumberArray(val)
        continue
      }
      if (key === 'fields' && Array.isArray(val)) {
        out[key] = val.map(f => this.hydrateRow<TableCertificateField>(f as Record<string, unknown>))
        continue
      }
      out[key] = val
    }
    if (out.created_at != null) out.created_at = this.validateDate(out.created_at as Date)
    if (out.updated_at != null) out.updated_at = this.validateDate(out.updated_at as Date)
    if (dateFields != null) {
      for (const df of dateFields) {
        if (out[df] != null) out[df] = this.validateDate(out[df] as Date)
      }
    }
    return out as T
  }

  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    const e = entity as unknown as Record<string, unknown>
    if (dateFields != null) {
      for (const df of dateFields) {
        if (e[df] != null) e[df] = this.validateDate(e[df] as Date)
      }
    }
    if (booleanFields != null) {
      for (const bf of booleanFields) {
        if (e[bf] !== undefined) e[bf] = e[bf] !== 0 && e[bf] != null && e[bf] !== false
      }
    }
    for (const key of Object.keys(e)) {
      const val = e[key]
      if (val === null) e[key] = undefined
      else if (val instanceof Uint8Array) e[key] = Array.from(val)
    }
    return entity
  }

  // ─── StorageProvider abstract methods ─────────────────────────────────────

  async reviewStatus(args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }> {
    return await reviewStatusIdb(this as unknown as StorageIdb, args)
  }

  async purgeData(_params: PurgeParams, _trx?: TrxToken): Promise<PurgeResults> {
    return { count: 0, log: '' }
  }

  async allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const raw = await this.writeCall<Record<string, unknown> | null>('allocateChangeInput', {
      userId,
      basketId,
      targetSatoshis,
      ...(exactSatoshis !== undefined ? { exactSatoshis } : {}),
      excludeSending,
      transactionId
    })
    return raw == null ? undefined : this.hydrateRow<TableOutput>(raw)
  }

  async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const map = await this.getProvenOrRawTxs([txid], trx)
    return map.get(txid) ?? { proven: undefined, rawTx: undefined, inputBEEF: undefined }
  }

  override async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>> {
    const results = new Map<string, ProvenOrRawTx>()
    const unique = [...new Set(txids)]
    if (unique.length === 0) return results
    const rawMap = await this.call<Record<string, Record<string, unknown>>>(
      'getProvenOrRawTxs',
      { txids: unique },
      trx
    )
    for (const txid of unique) {
      const entry = rawMap[txid]
      if (entry == null) {
        results.set(txid, { proven: undefined, rawTx: undefined, inputBEEF: undefined })
        continue
      }
      if (entry.proven != null) {
        results.set(txid, {
          proven: this.hydrateRow<TableProvenTx>(entry.proven as Record<string, unknown>),
          rawTx: undefined,
          inputBEEF: undefined
        })
      } else {
        results.set(txid, {
          proven: undefined,
          rawTx: typeof entry.rawTxB64 === 'string' ? base64ToNumberArray(entry.rawTxB64) : undefined,
          inputBEEF: typeof entry.inputBEEFB64 === 'string' ? base64ToNumberArray(entry.inputBEEFB64) : undefined
        })
      }
    }
    return results
  }

  async getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (txid == null || txid === '') return undefined
    if (!this.isAvailable()) await this.makeAvailable()
    const sliceRequested =
      offset !== undefined && length !== undefined && Number.isInteger(offset) && Number.isInteger(length)
    const b64 = await this.call<string | null>(
      'getRawTxOfKnownValidTransaction',
      sliceRequested ? { txid, offset, length } : { txid },
      trx
    )
    return typeof b64 === 'string' ? base64ToNumberArray(b64) : undefined
  }

  async getRawTxsForScriptSlices(txids: string[], trx?: TrxToken): Promise<Map<string, ArrayLike<number>>> {
    const results = new Map<string, ArrayLike<number>>()
    const unique = [...new Set(txids.filter(txid => txid !== ''))]
    if (unique.length === 0) return results
    if (!this.isAvailable()) await this.makeAvailable()
    const rawMap = await this.call<Record<string, string>>('getRawTxsForScriptSlices', { txids: unique }, trx)
    for (const [txid, b64] of Object.entries(rawMap)) {
      results.set(txid, base64ToUint8Array(b64))
    }
    return results
  }

  async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    if (transactionId == null) return []
    const rows = await this.call<Record<string, unknown>[]>(
      'getLabelsForTransactionId',
      { transactionId },
      trx
    )
    return rows.map(r => this.hydrateRow<TableTxLabel>(r))
  }

  async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const rows = await this.call<Record<string, unknown>[]>('getTagsForOutputId', { outputId }, trx)
    return rows.map(r => this.hydrateRow<TableOutputTag>(r))
  }

  async listActions(auth: AuthId, vargs: ValidListActionsArgs): Promise<ListActionsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await listActionsIdb(this as unknown as StorageIdb, auth, vargs)
  }

  async listOutputs(auth: AuthId, vargs: ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    const userId = verifyId(auth.userId)
    const { specOp, basket, tags } = getListOutputsSpecOp(vargs.basket, vargs.tags)

    // Ultra-fast SQL SUM path for wallet balance specOp
    if (specOp?.totalOutputsIsSumOfSatoshis === true && specOp.resultFromOutputs != null) {
      const totalOutputs = await this.call<number>('sumSpendableOutputs', {
        userId,
        basket: basket ?? undefined,
        tags,
        tagQueryMode: vargs.tagQueryMode,
        managedOnly: specOp.managedChangeOnly === true
      })
      return { totalOutputs, outputs: [] }
    }

    // Complex specOps (invalidChangeOutputs, setWalletChangeParams, walletManagedUtxos)
    if (specOp != null) {
      return await listOutputsIdb(this as unknown as StorageIdb, auth, vargs)
    }

    // Standard listOutputs hot path — ONE concurrent SQLite WAL read call!
    const resumeAfterOutputId = (vargs as ListOutputsResume).resumeAfterOutputId
    const skipTotal = (vargs as { skipTotal?: boolean }).skipTotal === true
    const fast = await this.call<{
      totalOutputs: number
      outputs: WalletOutput[]
      lastOutputId?: number
    }>('listOutputsFast', {
      userId,
      basket: basket ?? undefined,
      tags,
      tagQueryMode: vargs.tagQueryMode,
      limit: vargs.limit,
      offset: vargs.offset,
      includeTags: !!vargs.includeTags,
      includeLabels: !!vargs.includeLabels,
      includeLockingScripts: !!vargs.includeLockingScripts,
      includeCustomInstructions: !!vargs.includeCustomInstructions,
      skipTotal,
      ...(resumeAfterOutputId != null ? { resumeAfterOutputId } : {})
    })

    const result: ListOutputsResult = {
      totalOutputs: fast.totalOutputs,
      outputs: fast.outputs
    }
    if (fast.lastOutputId != null) {
      ;(result as ListOutputsResumeResult).lastOutputId = fast.lastOutputId
    }
    if (vargs.includeTransactions && result.outputs.length > 0) {
      const beef = new Beef()
      for (const wo of result.outputs) {
        const dot = wo.outpoint.lastIndexOf('.')
        const txid = dot > 0 ? wo.outpoint.slice(0, dot) : ''
        if (txid && beef.findTxid(txid) == null) {
          await this.getValidBeefForKnownTxid(txid, beef, undefined, vargs.knownTxids)
        }
      }
      result.BEEF = beef.toBinary()
    }
    return result
  }

  async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    return await this.call<number>('countChangeInputs', { userId, basketId, excludeSending })
  }

  override async findTransactionStatusesByIds(
    userId: number,
    transactionIds: number[],
    trx?: TrxToken
  ): Promise<Map<number, TransactionStatus>> {
    const statuses = new Map<number, TransactionStatus>()
    if (transactionIds.length === 0) return statuses
    const raw = await this.call<Record<string, TransactionStatus>>(
      'findTransactionStatusesByIds',
      { userId, transactionIds },
      trx
    )
    for (const [k, v] of Object.entries(raw)) statuses.set(Number(k), v)
    return statuses
  }

  override async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> {
    const byId: Record<number, TableOutput> = {}
    if (outputIds.length === 0) return byId
    const raw = await this.call<Record<string, Record<string, unknown>>>(
      'findOutputsByIds',
      { outputIds, noScript: false },
      trx
    )
    for (const [k, v] of Object.entries(raw)) byId[Number(k)] = this.hydrateRow<TableOutput>(v)
    return byId
  }

  override async findOutputsByOutpoints(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx?: TrxToken
  ): Promise<Record<string, TableOutput>> {
    if (outpoints.length === 0) return {}
    const raw = await this.call<Record<string, Record<string, unknown>>>(
      'findOutputsByOutpoints',
      { userId, outpoints, noScript: false },
      trx
    )
    const out: Record<string, TableOutput> = {}
    for (const [k, v] of Object.entries(raw)) out[k] = this.hydrateRow<TableOutput>(v)
    return out
  }

  override async findOutputsByOutpointsForUpdate(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx: TrxToken,
    noScript = false
  ): Promise<Record<string, TableOutput>> {
    if (outpoints.length === 0) return {}
    const raw = await this.call<Record<string, Record<string, unknown>>>(
      'findOutputsByOutpoints',
      { userId, outpoints, noScript },
      trx
    )
    const out: Record<string, TableOutput> = {}
    for (const [k, v] of Object.entries(raw)) out[k] = this.hydrateRow<TableOutput>(v)
    return out
  }

  async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    ) {
      throw new WERR_UNAUTHORIZED()
    }
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  override async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const userId = verifyId(auth.userId)
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findProvenTxReqs',
      {
        partial: serializePartialForWire(args.partial),
        status: args.status,
        txids: args.txids,
        since: toIsoDate(args.since),
        paged: args.paged,
        orderDescending: args.orderDescending,
        userId
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableProvenTxReq>(r))
  }

  async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    ) {
      throw new WERR_UNAUTHORIZED()
    }
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    ) {
      throw new WERR_UNAUTHORIZED()
    }
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (
      auth.userId == null ||
      (certificate.userId != null && certificate.userId !== 0 && certificate.userId !== auth.userId)
    ) {
      throw new WERR_UNAUTHORIZED()
    }
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  // ─── Find & Filter & Count Methods ────────────────────────────────────────

  async findUsers(args: FindUsersArgs): Promise<TableUser[]> {
    const rows = await this.call<Record<string, unknown>[]>(
      'findUsers',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableUser>(r))
  }

  async countUsers(args: FindUsersArgs): Promise<number> {
    return await this.call<number>(
      'countUsers',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findOutputBaskets',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableOutputBasket>(r))
  }

  async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countOutputBaskets',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    const rows = await this.call<Record<string, unknown>[]>(
      'findOutputTags',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableOutputTag>(r))
  }

  async filterOutputTags(args: FindOutputTagsArgs, filtered: (v: TableOutputTag) => void): Promise<void> {
    for (const row of await this.findOutputTags(args)) filtered(row)
  }

  async countOutputTags(args: FindOutputTagsArgs): Promise<number> {
    return await this.call<number>(
      'countOutputTags',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findOutputTagMaps(args: FindOutputTagMapsArgs, userId?: number): Promise<TableOutputTagMap[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findOutputTagMaps',
      {
        partial: serializePartialForWire(args.partial),
        tagIds: args.tagIds,
        since: toIsoDate(args.since),
        paged: args.paged,
        ...(userId !== undefined ? { userId } : {})
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableOutputTagMap>(r))
  }

  async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countOutputTagMaps',
      { partial: serializePartialForWire(args.partial), tagIds: args.tagIds, since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    const rows = await this.call<Record<string, unknown>[]>(
      'findTxLabels',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableTxLabel>(r))
  }

  async filterTxLabels(args: FindTxLabelsArgs, filtered: (v: TableTxLabel) => void): Promise<void> {
    for (const row of await this.findTxLabels(args)) filtered(row)
  }

  async countTxLabels(args: FindTxLabelsArgs): Promise<number> {
    return await this.call<number>(
      'countTxLabels',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findTxLabelMaps(args: FindTxLabelMapsArgs, userId?: number): Promise<TableTxLabelMap[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findTxLabelMaps',
      {
        partial: serializePartialForWire(args.partial),
        since: toIsoDate(args.since),
        paged: args.paged,
        ...(userId !== undefined ? { userId } : {})
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableTxLabelMap>(r))
  }

  async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countTxLabelMaps',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findCertificateFields',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableCertificateField>(r))
  }

  async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countCertificateFields',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findCertificates',
      {
        partial: serializePartialForWire(args.partial),
        certifiers: args.certifiers,
        types: args.types,
        includeFields: args.includeFields,
        since: toIsoDate(args.since),
        paged: args.paged
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableCertificateX>(r))
  }

  async countCertificates(args: FindCertificatesArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countCertificates',
      {
        partial: serializePartialForWire(args.partial),
        certifiers: args.certifiers,
        types: args.types,
        since: toIsoDate(args.since)
      },
      args.trx
    )
  }

  async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'partial.lockingScript',
        'undefined. Commissions may not be found by lockingScript value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findCommissions',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableCommission>(r))
  }

  async countCommissions(args: FindCommissionsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countCommissions',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    this.assertNoUndefinedInPartial(args.partial)
    const rows = await this.call<Record<string, unknown>[]>(
      'findMonitorEvents',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableMonitorEvent>(r))
  }

  async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countMonitorEvents',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    if (args.partial.syncMap != null && args.partial.syncMap !== '') {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.syncMap',
        'undefined. SyncStates may not be found by syncMap value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findSyncStates',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since), paged: args.paged },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableSyncState>(r, ['when']))
  }

  async countSyncStates(args: FindSyncStatesArgs): Promise<number> {
    return await this.call<number>(
      'countSyncStates',
      { partial: serializePartialForWire(args.partial), since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findProvenTxs(args: FindProvenTxsArgs, userId?: number): Promise<TableProvenTx[]> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxs may not be found by rawTx value.')
    }
    if (args.partial.merklePath != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.merklePath',
        'undefined. ProvenTxs may not be found by merklePath value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findProvenTxs',
      {
        partial: serializePartialForWire(args.partial),
        txids: args.txids,
        since: toIsoDate(args.since),
        paged: args.paged,
        orderDescending: args.orderDescending,
        ...(userId !== undefined ? { userId } : {})
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableProvenTx>(r))
  }

  async countProvenTxs(args: FindProvenTxsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countProvenTxs',
      { partial: serializePartialForWire(args.partial), txids: args.txids, since: toIsoDate(args.since) },
      args.trx
    )
  }

  async findProvenTxReqs(args: FindProvenTxReqsArgs, userId?: number): Promise<TableProvenTxReq[]> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.rawTx',
        'undefined. ProvenTxReqs may not be found by rawTx value.'
      )
    }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. ProvenTxReqs may not be found by inputBEEF value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findProvenTxReqs',
      {
        partial: serializePartialForWire(args.partial),
        status: args.status,
        txids: args.txids,
        since: toIsoDate(args.since),
        paged: args.paged,
        orderDescending: args.orderDescending,
        ...(args.noRawTx === true ? { noRawTx: true } : {}),
        ...(userId !== undefined ? { userId } : {})
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableProvenTxReq>(r))
  }

  async filterProvenTxReqs(
    args: FindProvenTxReqsArgs,
    filtered: (v: TableProvenTxReq) => void,
    userId?: number
  ): Promise<void> {
    if (args.paged != null) {
      for (const row of await this.findProvenTxReqs(args, userId)) filtered(row)
      return
    }
    // Stream in bounded chunks so large history exports never peak RAM.
    const pageSize = 100
    for (let offset = 0; ; offset += pageSize) {
      const batch = await this.findProvenTxReqs({ ...args, paged: { limit: pageSize, offset } }, userId)
      for (const row of batch) filtered(row)
      if (batch.length < pageSize) break
    }
  }

  async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countProvenTxReqs',
      {
        partial: serializePartialForWire(args.partial),
        status: args.status,
        txids: args.txids,
        since: toIsoDate(args.since)
      },
      args.trx
    )
  }

  async findTransactions(
    args: FindTransactionsArgs,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<TableTransaction[]> {
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.rawTx',
        'undefined. Transactions may not be found by rawTx value.'
      )
    }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. Transactions may not be found by inputBEEF value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findTransactions',
      {
        partial: serializePartialForWire(args.partial),
        status: args.status,
        from: toIsoDate(args.from),
        to: toIsoDate(args.to),
        since: toIsoDate(args.since),
        paged: args.paged,
        noRawTx: args.noRawTx,
        orderDescending: args.orderDescending,
        afterTransactionId: args.afterTransactionId,
        labelIds,
        isQueryModeAll
      },
      args.trx
    )
    return rows.map(r => this.hydrateRow<TableTransaction>(r))
  }

  async filterTransactions(
    args: FindTransactionsArgs,
    filtered: (v: TableTransaction) => void,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<void> {
    if (args.paged != null) {
      for (const row of await this.findTransactions(args, labelIds, isQueryModeAll)) filtered(row)
      return
    }
    const pageSize = 100
    let afterTransactionId = args.afterTransactionId
    for (;;) {
      const batch = await this.findTransactions(
        { ...args, afterTransactionId, paged: { limit: pageSize, offset: 0 } },
        labelIds,
        isQueryModeAll
      )
      for (const row of batch) filtered(row)
      if (batch.length < pageSize) break
      afterTransactionId = batch[batch.length - 1]!.transactionId
    }
  }

  async countTransactions(
    args: FindTransactionsArgs,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<number> {
    return await this.call<number>(
      'countTransactions',
      {
        partial: serializePartialForWire(args.partial),
        status: args.status,
        from: toIsoDate(args.from),
        to: toIsoDate(args.to),
        since: toIsoDate(args.since),
        labelIds,
        isQueryModeAll
      },
      args.trx
    )
  }

  async findOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<TableOutput[]> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.lockingScript',
        'undefined. Outputs may not be found by lockingScript value.'
      )
    }
    const rows = await this.call<Record<string, unknown>[]>(
      'findOutputs',
      {
        partial: serializePartialForWire(args.partial),
        txStatus: args.txStatus,
        managedOnly: args.managedOnly,
        noScript: args.noScript,
        since: toIsoDate(args.since),
        paged: args.paged,
        orderDescending: args.orderDescending,
        afterOutputId: args.afterOutputId,
        tagIds,
        isQueryModeAll
      },
      args.trx
    )
    if (args.scanStats != null) args.scanStats.visited += rows.length
    return rows.map(r => this.hydrateRow<TableOutput>(r))
  }

  async filterOutputs(
    args: FindOutputsArgs,
    filtered: (v: TableOutput) => void,
    tagIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<void> {
    if (args.paged != null) {
      for (const row of await this.findOutputs(args, tagIds, isQueryModeAll)) filtered(row)
      return
    }
    const pageSize = 200
    let afterOutputId = args.afterOutputId
    for (;;) {
      const batch = await this.findOutputs(
        { ...args, afterOutputId, paged: { limit: pageSize, offset: 0 } },
        tagIds,
        isQueryModeAll
      )
      for (const row of batch) filtered(row)
      if (batch.length < pageSize) break
      afterOutputId = batch[batch.length - 1]!.outputId
    }
  }

  async countOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    this.assertNoUndefinedInPartial(args.partial)
    return await this.call<number>(
      'countOutputs',
      {
        partial: serializePartialForWire(args.partial),
        txStatus: args.txStatus,
        managedOnly: args.managedOnly,
        since: toIsoDate(args.since),
        tagIds,
        isQueryModeAll
      },
      args.trx
    )
  }

  // ─── User-scoped Sync Queries ─────────────────────────────────────────────

  async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    return await this.findProvenTxs(
      { partial: {}, since: args.since, paged: args.paged, trx: args.trx },
      args.userId
    )
  }

  async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    return await this.findProvenTxReqs(
      { partial: {}, since: args.since, paged: args.paged, trx: args.trx },
      args.userId
    )
  }

  async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    return await this.findTxLabelMaps(
      { partial: {}, since: args.since, paged: args.paged, trx: args.trx },
      args.userId
    )
  }

  async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    return await this.findOutputTagMaps(
      { partial: {}, since: args.since, paged: args.paged, trx: args.trx },
      args.userId
    )
  }

  // ─── Inserts ──────────────────────────────────────────────────────────────

  async insertUser(user: TableUser, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertUser',
      { row: serializeForWire(user as unknown as Record<string, unknown>, false) },
      trx
    )
    user.userId = id
    return id
  }

  async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertOutputBasket',
      { row: serializeForWire(basket as unknown as Record<string, unknown>, false) },
      trx
    )
    basket.basketId = id
    return id
  }

  async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertProvenTx',
      { row: serializeForWire(tx as unknown as Record<string, unknown>, false) },
      trx
    )
    tx.provenTxId = id
    return id
  }

  async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertProvenTxReq',
      { row: serializeForWire(tx as unknown as Record<string, unknown>, false) },
      trx
    )
    tx.provenTxReqId = id
    return id
  }

  async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertTransaction',
      { row: serializeForWire(tx as unknown as Record<string, unknown>, false) },
      trx
    )
    tx.transactionId = id
    return id
  }

  async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertOutput',
      { row: serializeForWire(output as unknown as Record<string, unknown>, false) },
      trx
    )
    output.outputId = id
    return id
  }

  override async insertOutputs(outputs: TableOutput[], trx?: TrxToken): Promise<void> {
    if (outputs.length === 0) return
    const rows = outputs.map(o => serializeForWire(o as unknown as Record<string, unknown>, false))
    const ids = await this.writeCall<number[]>('insertOutputs', { rows }, trx)
    for (let i = 0; i < outputs.length; i++) {
      if (ids[i] != null) outputs[i]!.outputId = ids[i]!
    }
  }

  async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertOutputTag',
      { row: serializeForWire(tag as unknown as Record<string, unknown>, false) },
      trx
    )
    tag.outputTagId = id
    return id
  }

  async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    await this.writeCall(
      'insertOutputTagMap',
      { row: serializeForWire(tagMap as unknown as Record<string, unknown>, false) },
      trx
    )
  }

  async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertTxLabel',
      { row: serializeForWire(label as unknown as Record<string, unknown>, false) },
      trx
    )
    label.txLabelId = id
    return id
  }

  async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    await this.writeCall(
      'insertTxLabelMap',
      { row: serializeForWire(labelMap as unknown as Record<string, unknown>, false) },
      trx
    )
  }

  async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertCommission',
      { row: serializeForWire(commission as unknown as Record<string, unknown>, false) },
      trx
    )
    commission.commissionId = id
    return id
  }

  async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertCertificate',
      { row: serializeForWire(certificate as unknown as Record<string, unknown>, false) },
      trx
    )
    certificate.certificateId = id
    if (certificate.fields != null) {
      for (const field of certificate.fields) {
        field.certificateId = id
        field.userId = certificate.userId
      }
    }
    return id
  }

  async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    await this.writeCall(
      'insertCertificateField',
      { row: serializeForWire(certificateField as unknown as Record<string, unknown>, false) },
      trx
    )
  }

  async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertSyncState',
      { row: serializeForWire(syncState as unknown as Record<string, unknown>, false) },
      trx
    )
    syncState.syncStateId = id
    return id
  }

  async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertMonitorEvent',
      { row: serializeForWire(event as unknown as Record<string, unknown>, false) },
      trx
    )
    event.id = id
    return id
  }

  // ─── Updates ──────────────────────────────────────────────────────────────

  private assertUpdateKeyUnchanged(id: number | number[], update: Record<string, unknown>, keyProp: string): void {
    if (update[keyProp] !== undefined && (Array.isArray(id) || update[keyProp] !== id)) {
      throw new WERR_INVALID_PARAMETER(`update.${keyProp}`, 'undefined')
    }
  }

  async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'userId')
    return await this.writeCall<number>('updateUser', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'basketId')
    return await this.writeCall<number>('updateOutputBasket', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'outputId')
    return await this.writeCall<number>('updateOutput', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'transactionId')
    return await this.writeCall<number>('updateTransaction', { id, update: serializeForWire(rec, true) }, trx)
  }

  override async compareAndSetNoSendExpiryState(
    transactionId: number,
    expected: Brc177NoSendExpiryState,
    next: Brc177NoSendExpiryState,
    trx?: TrxToken
  ): Promise<boolean> {
    return await this.writeCall<boolean>(
      'compareAndSetNoSendExpiryState',
      { transactionId, expected, next },
      trx
    )
  }

  async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'provenTxId')
    return await this.writeCall<number>('updateProvenTx', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'provenTxReqId')
    return await this.writeCall<number>('updateProvenTxReq', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'outputTagId')
    return await this.writeCall<number>('updateOutputTag', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateOutputTagMap(
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    const rec = update as Record<string, unknown>
    const n = await this.writeCall<number>(
      'updateOutputTagMap',
      { outputId, tagId, update: serializeForWire(rec, true) },
      trx
    )
    if (n === 0) {
      throw new WERR_INVALID_PARAMETER(
        'key',
        `an existing record to update outputTagId,outputId ${tagId},${outputId} not found`
      )
    }
    return n
  }

  async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'txLabelId')
    return await this.writeCall<number>('updateTxLabel', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    const rec = update as Record<string, unknown>
    const n = await this.writeCall<number>(
      'updateTxLabelMap',
      { transactionId, txLabelId, update: serializeForWire(rec, true) },
      trx
    )
    if (n === 0) {
      throw new WERR_INVALID_PARAMETER(
        'key',
        `an existing record to update txLabelId,transactionId ${txLabelId},${transactionId} not found`
      )
    }
    return n
  }

  async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'commissionId')
    return await this.writeCall<number>('updateCommission', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'certificateId')
    return await this.writeCall<number>('updateCertificate', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateCertificateField(
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    const rec = update as Record<string, unknown>
    const n = await this.writeCall<number>(
      'updateCertificateField',
      { certificateId, fieldName, update: serializeForWire(rec, true) },
      trx
    )
    if (n === 0) {
      throw new WERR_INVALID_PARAMETER(
        'key',
        `an existing record to update certificateId,fieldName ${certificateId},${fieldName} not found`
      )
    }
    return n
  }

  async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'syncStateId')
    return await this.writeCall<number>('updateSyncState', { id, update: serializeForWire(rec, true) }, trx)
  }

  async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    const rec = update as Record<string, unknown>
    this.assertUpdateKeyUnchanged(id, rec, 'id')
    return await this.writeCall<number>('updateMonitorEvent', { id, update: serializeForWire(rec, true) }, trx)
  }

  // ─── Action Batches ───────────────────────────────────────────────────────

  override async insertActionBatch(batch: TableActionBatch, trx?: TrxToken): Promise<number> {
    const id = await this.writeCall<number>(
      'insertActionBatch',
      { row: serializeForWire(batch as unknown as Record<string, unknown>, false) },
      trx
    )
    batch.actionBatchId = id
    return id
  }

  override async findActionBatch(
    userId: number,
    batchId: string,
    trx?: TrxToken
  ): Promise<TableActionBatch | undefined> {
    const raw = await this.call<Record<string, unknown> | null>('findActionBatch', { userId, batchId }, trx)
    return raw == null ? undefined : this.hydrateRow<TableActionBatch>(raw, ['expiresAt', 'hardExpiresAt'])
  }

  override async findExpiredActionBatches(now: Date, trx?: TrxToken): Promise<TableActionBatch[]> {
    const rows = await this.call<Record<string, unknown>[]>(
      'findExpiredActionBatches',
      { now: now.toISOString() },
      trx
    )
    return rows.map(r => this.hydrateRow<TableActionBatch>(r, ['expiresAt', 'hardExpiresAt']))
  }

  override async updateActionBatch(
    actionBatchId: number,
    update: Partial<TableActionBatch>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.writeCall<number>(
      'updateActionBatch',
      { id: actionBatchId, update: serializeForWire(update as unknown as Record<string, unknown>, true) },
      trx
    )
  }

  override async deleteActionBatch(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.writeCall('deleteActionBatch', { actionBatchId }, trx)
  }

  override async reserveActionBatchOutputs(reservations: TableActionBatchOutput[], trx?: TrxToken): Promise<void> {
    if (reservations.length === 0) return
    await this.writeCall(
      'reserveActionBatchOutputs',
      { reservations: reservations.map(r => serializeForWire(r as unknown as Record<string, unknown>, false)) },
      trx
    )
  }

  override async findActionBatchOutputIds(actionBatchId: number, trx?: TrxToken): Promise<number[]> {
    return await this.call<number[]>('findActionBatchOutputIds', { actionBatchId }, trx)
  }

  override async findReservedActionBatchOutputIds(outputIds: number[], trx?: TrxToken): Promise<number[]> {
    if (outputIds.length === 0) return []
    return await this.call<number[]>('findReservedActionBatchOutputIds', { outputIds }, trx)
  }

  override async deleteActionBatchOutputReservations(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.writeCall('deleteActionBatchOutputReservations', { actionBatchId }, trx)
  }

  override async putActionBatchBlobRecord(blob: TableActionBatchBlob, trx?: TrxToken): Promise<void> {
    await this.putActionBatchBlobRecords([blob], trx)
  }

  override async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void> {
    if (blobs.length === 0) return
    await this.writeCall(
      'putActionBatchBlobRecords',
      { blobs: blobs.map(b => serializeForWire(b as unknown as Record<string, unknown>, false)) },
      trx
    )
  }

  override async findActionBatchBlobRecord(
    actionBatchId: number,
    digest: string,
    trx?: TrxToken
  ): Promise<TableActionBatchBlob | undefined> {
    return verifyOneOrNone(await this.findActionBatchBlobRecords(actionBatchId, [digest], trx))
  }

  override async findActionBatchBlobRecords(
    actionBatchId: number,
    digests: string[],
    trx?: TrxToken
  ): Promise<TableActionBatchBlob[]> {
    if (digests.length === 0) return []
    const rows = await this.call<Record<string, unknown>[]>(
      'findActionBatchBlobRecords',
      { actionBatchId, digests },
      trx
    )
    return rows.map(r => this.hydrateRow<TableActionBatchBlob>(r, undefined, ['bytes']))
  }

  override async deleteActionBatchBlobRecords(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.writeCall('deleteActionBatchBlobRecords', { actionBatchId }, trx)
  }

  // ─── Migration Helpers ────────────────────────────────────────────────────

  async importMigrationChunk(table: string, rows: Record<string, unknown>[], trx: TrxToken): Promise<number> {
    const wireRows = rows.map(r => serializeForWire(r, false))
    const res = await this.call<{ imported: number }>('importMigrationChunk', { table, rows: wireRows }, trx)
    return res.imported
  }

  async setMeta(key: string, value: string, trx?: TrxToken): Promise<void> {
    await this.writeCall('setMeta', { key, value }, trx)
  }

  async tableCounts(trx?: TrxToken): Promise<Record<string, number>> {
    return await this.call<Record<string, number>>('tableCounts', {}, trx)
  }

  async adminStats(_adminIdentityKey: string): Promise<StorageAdminStats> {
    throw new Error('Method intentionally not implemented for personal storage.')
  }
}

// ─── Non-Destructive One-Time Migration from Legacy IndexedDB → SQLite WAL ───

const MIGRATION_STORES = [
  'settings',
  'users',
  'output_baskets',
  'proven_txs',
  'proven_tx_reqs',
  'transactions',
  'outputs',
  'output_tags',
  'output_tags_map',
  'tx_labels',
  'tx_labels_map',
  'commissions',
  'certificates',
  'certificate_fields',
  'sync_states',
  'monitor_events',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs'
] as const

const inFlightMigrations = new Map<string, Promise<void>>()

async function idbDatabaseExists(databaseName: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases()
      return list.some(d => d.name === databaseName)
    } catch {
      // Fall through to open probe.
    }
  }
  return true
}

function estimateRowBytes(row: Record<string, unknown>): number {
  let total = 256
  for (const val of Object.values(row)) {
    if (val instanceof Uint8Array) total += val.byteLength
    else if (Array.isArray(val)) total += val.length
    else if (typeof val === 'string') total += val.length
  }
  return total
}

/**
 * Safely and non-destructively migrates an existing IndexedDB Toolbox database into
 * `StorageRustSqlite` on first open.
 *
 * - Never modifies or deletes IndexedDB (keeps it intact as a read-only backup).
 * - Streams rows in bounded chunks inside ONE atomic SQLite transaction so huge
 *   inscription wallets never exhaust WebView RAM or IPC message sizes.
 * - Verifies per-table row counts before committing and setting `migrated_from_idb = '1'`.
 */
export async function migrateLegacyIdbToRustSqlite(
  sqlite: StorageRustSqlite,
  databaseName: string
): Promise<void> {
  const existing = inFlightMigrations.get(databaseName)
  if (existing != null) return await existing

  const task = (async () => {
    const info = sqlite.getLastOpenInfo()
    if (info?.migratedFromIdb === true) return
    const existingRows =
      (info?.counts?.users ?? 0) + (info?.counts?.transactions ?? 0) + (info?.counts?.outputs ?? 0)
    if (existingRows > 0) {
      await sqlite.setMeta('migrated_from_idb', '1')
      return
    }

    if (!(await idbDatabaseExists(databaseName))) {
      await sqlite.setMeta('migrated_from_idb', '1')
      return
    }

    const started = Date.now()
    let createdEmptyProbe = false
    const idb = await new Promise<IDBDatabase | null>(resolve => {
      const req = indexedDB.open(databaseName)
      req.onupgradeneeded = () => {
        createdEmptyProbe = true
      }
      req.onerror = () => resolve(null)
      req.onsuccess = () => resolve(req.result)
    })

    if (idb == null || createdEmptyProbe || !idb.objectStoreNames.contains('users')) {
      idb?.close()
      if (createdEmptyProbe) {
        try {
          indexedDB.deleteDatabase(databaseName)
        } catch {}
      }
      await sqlite.setMeta('migrated_from_idb', '1')
      return
    }

    try {
      const userCount = await new Promise<number>((resolve, reject) => {
        const req = idb.transaction('users', 'readonly').objectStore('users').count()
        req.onerror = () => reject(req.error ?? new Error('IDB users count failed'))
        req.onsuccess = () => resolve(req.result)
      })
      if (userCount === 0) {
        await sqlite.setMeta('migrated_from_idb', '1')
        return
      }

      const expectedCounts: Record<string, number> = {}

      await sqlite.transaction(async trx => {
        for (const storeName of MIGRATION_STORES) {
          if (!idb.objectStoreNames.contains(storeName)) continue

          const allStoreRows: Record<string, unknown>[] = []
          await new Promise<void>((resolve, reject) => {
            const tx = idb.transaction(storeName, 'readonly')
            const req = tx.objectStore(storeName).openCursor()
            req.onerror = () => reject(req.error ?? new Error(`IDB cursor failed on ${storeName}`))
            req.onsuccess = () => {
              const cursor = req.result
              if (cursor == null) {
                resolve()
                return
              }
              allStoreRows.push(cursor.value as Record<string, unknown>)
              cursor.continue()
            }
          })

          if (storeName !== 'settings') {
            expectedCounts[storeName] = allStoreRows.length
          }
          if (allStoreRows.length === 0) continue

          // Flush in chunks bounded by both row count (150) and raw byte budget (1.5 MiB)
          const MAX_ROWS_PER_CHUNK = 150
          const MAX_BYTES_PER_CHUNK = 1_500_000
          let chunk: Record<string, unknown>[] = []
          let chunkBytes = 0
          for (const row of allStoreRows) {
            const rowBytes = estimateRowBytes(row)
            if (chunk.length > 0 && (chunk.length >= MAX_ROWS_PER_CHUNK || chunkBytes + rowBytes > MAX_BYTES_PER_CHUNK)) {
              await sqlite.importMigrationChunk(storeName, chunk, trx)
              chunk = []
              chunkBytes = 0
            }
            chunk.push(row)
            chunkBytes += rowBytes
          }
          if (chunk.length > 0) {
            await sqlite.importMigrationChunk(storeName, chunk, trx)
          }
        }

        // Verify every migrated table count matches IndexedDB before committing!
        const actualCounts = await sqlite.tableCounts(trx)
        for (const [table, expected] of Object.entries(expectedCounts)) {
          const actual = actualCounts[table] ?? 0
          if (actual !== expected) {
            throw new WERR_INVALID_OPERATION(
              `SQLite migration count mismatch on ${table}: expected ${expected}, got ${actual}`
            )
          }
        }
        await sqlite.setMeta('migrated_from_idb', '1', trx)
      })

      await sqlite.reloadSettings()
      console.info(
        `[storage-sqlite] migrated ${databaseName} from IndexedDB in ${Date.now() - started}ms — ` +
          `users=${expectedCounts.users ?? 0} txs=${expectedCounts.transactions ?? 0} ` +
          `outputs=${expectedCounts.outputs ?? 0} proven=${expectedCounts.proven_txs ?? 0} ` +
          `reqs=${expectedCounts.proven_tx_reqs ?? 0}`
      )
    } finally {
      idb.close()
    }
  })()

  inFlightMigrations.set(databaseName, task)
  try {
    await task
  } finally {
    if (inFlightMigrations.get(databaseName) === task) inFlightMigrations.delete(databaseName)
  }
}
