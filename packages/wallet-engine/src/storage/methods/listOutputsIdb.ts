import { type ValidListOutputsArgs } from '@bsv/sdk/wallet/validationHelpers'
import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput } from '@bsv/sdk'
import { getListOutputsSpecOp, type ListOutputsSpecOp } from './ListOutputsSpecOp'
import { StorageIdb } from '../StorageIdb'
import { AuthId, FindOutputsArgs, OutputScanStats } from '../../sdk/WalletStorage.interfaces'
import { verifyId } from '../../utility/utilityHelpers'
import { TableOutput } from '../schema/tables/TableOutput'
import { TransactionStatus } from '../../sdk/types'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { isManagedChangeOutput, managedChangeOutputFields } from './managedChange'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

interface ResolvedListTags {
  tags: string[]
  specOpTags: string[]
  basketId?: number
}

interface IdbOutputQuery {
  storage: StorageIdb
  userId: number
  basketId: number | undefined
  tagIds: number[]
  queryModeAll: boolean
  specOp: ListOutputsSpecOp | undefined
  limit: number
  offset: number
  orderDescending: boolean
  skipTotal?: boolean
  afterOutputId?: number
  stats: ListReadStats
}

interface ListReadStats extends OutputScanStats {
  countMs: number | null
}

/** A read this slow, or one that re-reads this many rows to honour an offset, is logged. */
const SLOW_LIST_MS = 250
const OFFSET_REREAD_ROWS = 100

/**
 * Internal, beside BRC-100 `listOutputs`: a slicing caller passes the
 * `lastOutputId` of its previous slice as `resumeAfterOutputId` (with the
 * equivalent offset), and the scan opens there instead of re-reading every
 * newer row. Results that do not carry `lastOutputId` must be paged by offset.
 */
export interface ListOutputsResume {
  resumeAfterOutputId?: number
}
export interface ListOutputsResumeResult {
  lastOutputId?: number
}

function normalizeListOffset(offset: number): {
  offset: number
  orderDescending: boolean
} {
  return offset < 0 ? { offset: -offset - 1, orderDescending: true } : { offset, orderDescending: false }
}

async function resolveIdbBasketId(
  storage: StorageIdb,
  userId: number,
  basket: string | undefined
): Promise<number | null | undefined> {
  if (basket == null || basket === '') return undefined
  const baskets = await storage.findOutputBaskets({
    partial: { userId, name: basket }
  })
  return baskets.length === 1 ? baskets[0].basketId : null
}

function resolveListTags(
  specOp: ListOutputsSpecOp | undefined,
  sourceTags: string[],
  initialBasketId: number | undefined
): ResolvedListTags {
  const tags = sourceTags.slice()
  const specOpTags: string[] = []
  let basketId = initialBasketId
  if (specOp?.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp?.tagsToIntercept == null) return { tags, specOpTags, basketId }
  const remaining: string[] = []
  for (const tag of tags) {
    if (specOp.tagsToIntercept.length === 0 || specOp.tagsToIntercept.includes(tag)) {
      specOpTags.push(tag)
      if (tag === 'all') basketId = undefined
    } else {
      remaining.push(tag)
    }
  }
  return { tags: remaining, specOpTags, basketId }
}

async function findIdbTagIds(storage: StorageIdb, userId: number, tags: string[]): Promise<number[]> {
  const tagIds: number[] = []
  if (tags.length === 0) return tagIds
  await storage.filterOutputTags({ partial: { userId, isDeleted: false } }, outputTag => {
    if (tags.includes(outputTag.tag)) tagIds.push(outputTag.outputTagId)
  })
  return tagIds
}

function tagQueryCannotMatch(tags: string[], tagIds: number[], queryModeAll: boolean): boolean {
  return queryModeAll ? tagIds.length < tags.length : tags.length > 0 && tagIds.length === 0
}

async function loadIdbOutputs(query: IdbOutputQuery): Promise<{ outputs: TableOutput[]; totalOutputs: number }> {
  const { storage, userId, basketId, tagIds, queryModeAll, specOp, limit, offset, orderDescending } = query
  const args: FindOutputsArgs = {
    partial: {
      userId,
      basketId,
      spendable: true,
      ...(specOp?.managedChangeOnly ? managedChangeOutputFields : {})
    },
    txStatus: ['completed', 'unproven', 'nosend', 'sending'] as TransactionStatus[],
    noScript: specOp?.includeOutputScripts !== true,
    orderDescending,
    afterOutputId: query.afterOutputId,
    scanStats: query.stats
  }
  // BRC-100 listOutputs: filter eligible managed change inside the cursor,
  // before paging, rather than materialising the entire wallet on every page.
  args.managedOnly = specOp?.managedChangeOnly === true
  const applyPaging = !specOp?.ignoreLimit
  if (applyPaging) {
    args.paged = { limit, offset }
  } else if (specOp?.maximumCandidateCount != null) {
    args.paged = { limit: specOp.maximumCandidateCount + 1, offset: 0 }
  }
  let outputs = await storage.findOutputs(args, tagIds, queryModeAll)
  if (specOp?.maximumCandidateCount != null && outputs.length > specOp.maximumCandidateCount) {
    throw new WERR_INVALID_OPERATION(
      `${specOp.name} is limited to ${specOp.maximumCandidateCount} candidates; use a bounded paged review.`
    )
  }
  if (specOp?.managedChangeOnly) {
    outputs = outputs.filter(output => isManagedChangeOutput(output) && output.spentBy == null)
  }
  if (outputs.length !== limit) {
    // A short page ends the result set, so the total is the rows the offset
    // skipped plus the rows returned, with no second query. `offset` only
    // counts when it was actually applied. An empty page is the exception: it
    // proves only that the offset is at or past the end, so the total still
    // has to be counted.
    const skipped = applyPaging ? offset : 0
    if (outputs.length > 0 || skipped === 0) {
      return { outputs, totalOutputs: skipped + outputs.length }
    }
  }
  if (query.skipTotal === true && outputs.length > 0) {
    // Caller is slicing one logical page and only needs the total once, on the
    // last slice. A lower bound spares a whole-basket count per slice.
    return { outputs, totalOutputs: (applyPaging ? offset : 0) + outputs.length }
  }
  args.paged = undefined
  args.afterOutputId = undefined
  args.scanStats = undefined
  const countStarted = Date.now()
  const totalOutputs = await storage.countOutputs(args, tagIds, queryModeAll)
  query.stats.countMs = Date.now() - countStarted
  return { outputs, totalOutputs }
}

async function hydrateIdbWalletOutput(
  storage: StorageIdb,
  output: TableOutput,
  vargs: ValidListOutputsArgs,
  labelsByTxid: Record<string, string[]>,
  beef: Beef
): Promise<WalletOutput> {
  const walletOutput: WalletOutput = {
    satoshis: Number(output.satoshis),
    spendable: !!output.spendable,
    outpoint: `${output.txid}.${output.vout}`
  }
  if (vargs.includeCustomInstructions && output.customInstructions) {
    walletOutput.customInstructions = output.customInstructions
  }
  if (vargs.includeLabels && output.txid) {
    labelsByTxid[output.txid] ??= (await storage.getLabelsForTransactionId(output.transactionId)).map(
      label => label.label
    )
    walletOutput.labels = labelsByTxid[output.txid]
  }
  if (vargs.includeTags) {
    walletOutput.tags = (await storage.getTagsForOutputId(output.outputId)).map(tag => tag.tag)
  }
  if (vargs.includeLockingScripts) {
    await storage.validateOutputScript(output)
    if (output.lockingScript != null) {
      walletOutput.lockingScript = asString(output.lockingScript)
    }
  }
  if (vargs.includeTransactions && output.txid != null && beef.findTxid(output.txid) == null) {
    await storage.getValidBeefForKnownTxid(output.txid, beef, undefined, vargs.knownTxids)
  }
  return walletOutput
}

async function hydrateIdbOutputResult(
  storage: StorageIdb,
  outputs: TableOutput[],
  vargs: ValidListOutputsArgs,
  result: ListOutputsResult
): Promise<void> {
  const labelsByTxid: Record<string, string[]> = {}
  const beef = new Beef()
  for (const output of outputs) {
    result.outputs.push(await hydrateIdbWalletOutput(storage, output, vargs, labelsByTxid, beef))
  }
  if (vargs.includeTransactions) result.BEEF = beef.toBinary()
}

export async function listOutputsIdb(
  storage: StorageIdb,
  auth: AuthId,
  vargs: ValidListOutputsArgs,
  _originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<ListOutputsResult> {
  const userId = verifyId(auth.userId)
  const limit = vargs.limit
  const { offset, orderDescending } = normalizeListOffset(vargs.offset)
  const result: ListOutputsResult = { totalOutputs: 0, outputs: [] }
  const { specOp, basket, tags: sourceTags } = getListOutputsSpecOp(vargs.basket, vargs.tags)
  const resolvedBasketId = await resolveIdbBasketId(storage, userId, basket)
  if (resolvedBasketId === null) return result
  const { tags, specOpTags, basketId } = resolveListTags(specOp, sourceTags, resolvedBasketId)
  if (specOp?.resultFromTags != null) {
    return specOp.resultFromTags(storage, auth, vargs, specOpTags)
  }
  const tagIds = await findIdbTagIds(storage, userId, tags)
  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (tagQueryCannotMatch(tags, tagIds, isQueryModeAll)) return result
  const started = Date.now()
  const stats: ListReadStats = { visited: 0, skipped: 0, countMs: null }
  const resumeAfter = specOp == null ? (vargs as ListOutputsResume).resumeAfterOutputId : undefined
  let { outputs, totalOutputs } = await loadIdbOutputs({
    storage,
    userId,
    basketId,
    tagIds,
    queryModeAll: isQueryModeAll,
    specOp,
    limit,
    offset,
    orderDescending,
    skipTotal: (vargs as { skipTotal?: boolean }).skipTotal === true,
    afterOutputId: resumeAfter,
    stats
  })
  const loadedAt = Date.now()
  const report = (returned: number) =>
    logListRead(vargs, offset, resumeAfter != null, stats, returned, loadedAt - started, Date.now() - loadedAt)
  result.totalOutputs = totalOutputs
  if (specOp == null && outputs.length > 0) {
    ;(result as ListOutputsResumeResult).lastOutputId = outputs[outputs.length - 1].outputId
  }
  if (specOp != null) {
    if (specOp.filterOutputs != null) {
      outputs = await specOp.filterOutputs(storage, auth, vargs, specOpTags, outputs)
      result.totalOutputs = outputs.length
    }
    if (specOp.resultFromOutputs != null) {
      const fromOutputs = await specOp.resultFromOutputs(storage, auth, vargs, specOpTags, outputs)
      report(outputs.length)
      return fromOutputs
    }
  }
  await hydrateIdbOutputResult(storage, outputs, vargs, result)
  report(outputs.length)
  return result
}

/**
 * One parseable line per slow read, or per read that re-read rows to honour an
 * offset: `via=offset skipped=N` names a caller still paging by offset, and
 * `count=Nms` a whole-basket count that ran because the page came back full.
 */
function logListRead(
  vargs: ValidListOutputsArgs,
  offset: number,
  resumed: boolean,
  stats: ListReadStats,
  returned: number,
  loadMs: number,
  hydrateMs: number
): void {
  const ms = loadMs + hydrateMs
  if (ms < SLOW_LIST_MS && stats.skipped < OFFSET_REREAD_ROWS) return
  const line =
    `[list-outputs] basket=${vargs.basket || '-'} limit=${vargs.limit} offset=${offset} ` +
    `via=${resumed ? 'resume' : 'offset'} visited=${stats.visited} skipped=${stats.skipped} returned=${returned} ` +
    `count=${stats.countMs == null ? 'none' : `${stats.countMs}ms`} load=${loadMs}ms hydrate=${hydrateMs}ms done ${ms}ms`
  if (stats.skipped >= OFFSET_REREAD_ROWS) console.warn(line)
  else console.info(line)
}
