/**
 * Follow every Arcade-accepted cheque until a node holds it.
 *
 * Arcade's 202 is a queue receipt. The send stays fast because nothing here
 * sits on the reply path: signing answers the app, `minerSubmit` posts, and
 * this watch runs afterwards. What it adds is the part the 202 skipped —
 * asking Arcade what the network actually said, and acting on it:
 *
 * - `landed`: a node holds it, or it is on chain. Remembered, never re-asked.
 * - `dead` (see `kernel/landingFate`): a node rejected it, a node or explorer
 *   names another spender of an input, or it spends change of a cheque
 *   already proven dead. The send is failed as a closure, the dead coins are hidden under
 *   their named spender, the pool is swept, and Activity says "not sent".
 * - `waiting`: Arcade still retrying with nothing proven. Once per watch the
 *   body is re-posted to the non-Arcade miners — Arcade's first success ends
 *   the toolbox round, so a stall inside Arcade otherwise reaches nobody else.
 *
 * Unlock replays every pinned cheque that never landed, oldest first, so a
 * night of sends Arcade could not land is repaired on the next launch.
 */
import type { Services } from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import type { BoundAccountKeyScope } from './accountLocalKeys'
import { accountKeyScopeFor } from './accountLocalKeys'
import {
  getWalletRuntime,
  runtimeIsCurrent,
  type WalletRuntime,
} from './walletRuntime'
import { noteTxLanded, resetLandedTxForTests, txLanded } from './landedTx'
import { normalizeTxid } from './txid'
import { listWalletJobs } from './walletJobs'
import {
  decideLanding,
  decideRescue,
  withArcadeConflict,
  type LandingArcade,
  type LandingEvidence,
  type LandingFate,
} from './kernel/landingFate'
import type { ArcadeTxFate } from './arcadeV2'

/** Pauses between Arcade reads for one cheque (≈31 min in all). */
const WATCH_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000,
] as const
const WATCH_SPAN_MS = WATCH_DELAYS_MS.reduce((a, b) => a + b, 0)
const EVIDENCE_PROBE_MS = 4_000
/** Unlock settles (history restore, first ingest) before the replay. */
const UNLOCK_DELAY_MS = 8_000
/** A pin younger than this is still inside its own live watch. */
const UNLOCK_MIN_AGE_MS = 60_000
const UNLOCK_MAX_PINS = 200
/** WhatsOnChain keyless budget; the replay shares it with live signs. */
const UNLOCK_GAP_MS = 400
const SPEND_POLL_MS = 500
const SPEND_WAIT_MAX_MS = 60_000

export { noteTxLanded, txLanded } from './landedTx'

const watching = new Set<string>()
const unlockedRuntimes = new Set<string>()

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function resetArcadeLandingForTests(): void {
  resetLandedTxForTests()
  watching.clear()
  unlockedRuntimes.clear()
}

export function toLandingArcade(fate: ArcadeTxFate, isLanded: (status: string) => boolean): LandingArcade {
  switch (fate.kind) {
    case 'accepted':
      return isLanded(fate.status)
        ? { kind: 'landed', status: fate.status }
        : { kind: 'queued', status: fate.status }
    case 'stalled':
    case 'retryable':
      return { kind: 'stalled', status: fate.status, reason: fate.reason }
    case 'rejected':
      return fate.conflict
        ? { kind: 'rejected', reason: fate.reason, conflict: fate.conflict }
        : { kind: 'rejected', reason: fate.reason }
    default:
      return { kind: 'unknown' }
  }
}

async function landingEvidence(
  txid: string,
  atomic: number[] | undefined,
  chain: Chain,
): Promise<LandingEvidence> {
  const { txExistsOnChain } = await import('./legacyScan')
  const onChain = await txExistsOnChain(txid, chain).catch(() => null)
  if (onChain === true) return { onChain, spentElsewhere: [], rejectedParents: [] }

  const { inputOutpointsForSignedTx } = await import('./signedTxInputs')
  const inputs = await inputOutpointsForSignedTx(txid, atomic)
  if (inputs.length === 0) return { onChain, spentElsewhere: [], rejectedParents: [] }

  const { txIsArcadeRejected } = await import('./arcadeSubmitGuard')
  const rejectedParents = [
    ...new Set(
      inputs
        .map((op) => normalizeTxid(op.split(/[._:]/)[0] ?? ''))
        .filter((parent): parent is string => !!parent && txIsArcadeRejected(parent)),
    ),
  ]
  const { probeOutpointSpends } = await import('./createActionInputFate')
  const probes = await probeOutpointSpends(inputs, txid, chain, EVIDENCE_PROBE_MS)
  const spentElsewhere = inputs.flatMap((outpoint) => {
    const probe = probes.get(outpoint)
    return probe?.kind === 'spent' ? [{ outpoint, spender: probe.spender }] : []
  })
  return { onChain, spentElsewhere, rejectedParents }
}

const IMPORT_POLL_MS = 2_000
const IMPORT_KINDS = new Set(['item-import', 'phrase-import', 'one-sat-import'])
const IMPORT_JOB_KINDS = new Set(['item-import', 'wallet-sweep'])

/**
 * Hold the unlock replay while an import runs. Its explorer reads and storage
 * walks queue on the same Toolbox lock as every migrate's createAction, which
 * waited out a five-minute replay of week-old sends. A saved-wallet sweep runs
 * as a wallet job without the progress bus, so both are asked.
 */
async function waitForImportsToSettle(runtime: WalletRuntime): Promise<boolean> {
  const { getWalletProgress } = await import('./walletProgress')
  for (;;) {
    if (!runtimeIsCurrent(runtime)) return false
    const progress = getWalletProgress()
    const progressBusy = progress.status === 'running' && !!progress.kind && IMPORT_KINDS.has(progress.kind)
    const jobBusy = listWalletJobs(runtime.instance.identityKey).some(
      (job) => IMPORT_JOB_KINDS.has(job.kind) && (job.face === 'running' || job.face === 'waiting'),
    )
    if (!progressBusy && !jobBusy) return true
    await delay(IMPORT_POLL_MS)
  }
}

async function waitForSpendRegion(): Promise<boolean> {
  const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
  const deadline = Date.now() + SPEND_WAIT_MAX_MS
  while (shouldYieldChainIngestToSpend()) {
    if (Date.now() > deadline) return false
    await delay(SPEND_POLL_MS)
  }
  return true
}

function deadLabel(fate: Extract<LandingFate, { kind: 'dead' }>): string {
  switch (fate.cause) {
    case 'input-spent-elsewhere':
      return 'Not on chain — a coin it spent was already spent'
    case 'parent-rejected':
      return 'Not on chain — it spent change from a payment that failed'
    default:
      return `Not on chain — ${fate.reason}`.slice(0, 120)
  }
}

/**
 * Fail a cheque the chain will never take. Order matters: failing restores
 * the inputs, so the dead ones are hidden after, under their named spender.
 */
async function retireDeadCheque(args: {
  txid: string
  fate: Extract<LandingFate, { kind: 'dead' }>
  evidence: LandingEvidence
  runtime: WalletRuntime
  owner?: BoundAccountKeyScope
  toast: boolean
}): Promise<boolean> {
  const { txid, fate, evidence, runtime } = args
  if (!(await waitForSpendRegion())) return false
  if (!runtimeIsCurrent(runtime)) return false
  const started = Date.now()

  const { noteArcadeRejectedTx } = await import('./arcadeSubmitGuard')
  noteArcadeRejectedTx(txid)
  const { removePendingMinerSubmit } = await import('./pendingMinerOutbox')
  removePendingMinerSubmit(txid, args.owner)
  try {
    const { rememberGhostTx } = await import('./ghostTxSuppress')
    rememberGhostTx(txid)
  } catch {
    /* optional */
  }

  const { failUnsentLocalTx, hideSpentOutpoints } = await import('./staleOutputRelease')
  await failUnsentLocalTx(txid, { force: true })
  const bySpender = new Map<string, string[]>()
  for (const row of evidence.spentElsewhere) {
    const list = bySpender.get(row.spender) ?? []
    list.push(row.outpoint)
    bySpender.set(row.spender, list)
  }
  let hidden = 0
  for (const [spender, outpoints] of bySpender) {
    hidden += await hideSpentOutpoints(outpoints, spender, runtime.instance)
  }
  if (bySpender.size > 0) {
    const { scheduleDeadCoinSweep } = await import('./deadCoinSweep')
    scheduleDeadCoinSweep(runtime.instance.chain, bySpender.keys())
  }
  const { bumpBalanceAfterHeal } = await import('./session')
  bumpBalanceAfterHeal()

  const { reportLateMinerSubmitFailure } = await import('./minerSubmit')
  await reportLateMinerSubmitFailure({
    txid,
    reason: new Error(deadLabel(fate)),
    toast: args.toast,
  })
  console.warn(
    `[landing] ${txid.slice(0, 12)} dead cause=${fate.cause} hidden=${hidden} — ${fate.reason} done ${
      Date.now() - started
    }ms`,
  )
  return true
}

/**
 * Hand the body to every non-Arcade miner until one accepts it. Best effort:
 * a dead body is refused there too, and a live one lands without Arcade.
 */
async function repostOutsideArcade(
  services: Services,
  txid: string,
  atomic: number[],
): Promise<void> {
  const list = (
    services as unknown as {
      postBeefServices?: {
        services?: Array<{
          name: string
          service: (beef: unknown, txids: string[]) => Promise<unknown>
        }>
      }
    }
  ).postBeefServices?.services
  if (!Array.isArray(list)) return
  const { Beef } = await import('@bsv/sdk')
  const { isArcadeNamedService, summarizePostBeef } = await import('./postBeefResult')
  for (const entry of list) {
    if (isArcadeNamedService(entry.name) || typeof entry.service !== 'function') continue
    try {
      const result = await entry.service(Beef.fromBinary(atomic), [txid])
      const summary = summarizePostBeef([{ name: entry.name, ...(result as object) }])
      console.info(
        `[landing] ${txid.slice(0, 12)} re-posted outside Arcade via ${entry.name}: ${summary.detail}`,
      )
      if (summary.accepted) return
    } catch (err) {
      console.info(
        `[landing] ${txid.slice(0, 12)} re-post via ${entry.name} failed`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

type LandingRound = {
  fate: LandingFate
  arcade: LandingArcade
  evidence?: LandingEvidence
}

async function checkLanding(args: {
  txid: string
  runtime: WalletRuntime
  owner?: BoundAccountKeyScope
  atomic?: number[]
  since: number
  toast: boolean
}): Promise<LandingRound> {
  const { txid, runtime } = args
  const chain = runtime.instance.chain
  const { fetchArcadeTxFate, arcadeStatusLanded } = await import('./arcadeV2')
  const arcade = toLandingArcade(await fetchArcadeTxFate(chain, txid), arcadeStatusLanded)
  const elapsedMs = Date.now() - args.since
  let fate = decideLanding({ arcade, elapsedMs })
  let evidence: LandingEvidence | undefined
  if (fate.kind === 'gatherEvidence') {
    evidence = withArcadeConflict(await landingEvidence(txid, args.atomic, chain), arcade)
    fate = decideLanding({ arcade, elapsedMs, evidence })
  }
  if (!runtimeIsCurrent(runtime)) {
    return { fate: { kind: 'waiting', reason: 'account changed' }, arcade, evidence }
  }
  if (fate.kind === 'landed') {
    noteTxLanded(txid)
    console.info(`[landing] ${txid.slice(0, 12)} landed ${fate.reason} done ${elapsedMs}ms`)
  } else if (fate.kind === 'dead' && evidence) {
    const retired = await retireDeadCheque({
      txid,
      fate,
      evidence,
      runtime,
      owner: args.owner,
      toast: args.toast,
    })
    if (!retired) return { fate: { kind: 'waiting', reason: 'spend busy' }, arcade, evidence }
  }
  return { fate, arcade, evidence }
}

/**
 * Start following one Arcade-accepted cheque. Never awaited by a send; one
 * watch per txid, and none for a cheque already landed or proven dead.
 */
export function watchArcadeLanding(
  txid: string,
  opts?: { atomic?: number[]; owner?: BoundAccountKeyScope; since?: number },
): void {
  const id = normalizeTxid(txid)
  if (!id || watching.has(id) || txLanded(id)) return
  const runtime = getWalletRuntime()
  if (!runtime) return
  watching.add(id)
  const since = opts?.since ?? Date.now()
  const owner = opts?.owner ?? accountKeyScopeFor(runtime.instance)
  void (async () => {
    const { txIsArcadeRejected } = await import('./arcadeSubmitGuard')
    let reposted = false
    for (const wait of WATCH_DELAYS_MS) {
      await delay(wait)
      if (!runtimeIsCurrent(runtime) || txIsArcadeRejected(id)) return
      const round = await checkLanding({
        txid: id,
        runtime,
        owner,
        atomic: opts?.atomic,
        since,
        toast: true,
      })
      if (round.fate.kind === 'landed' || round.fate.kind === 'dead') return
      if (!reposted && round.arcade.kind === 'stalled' && round.evidence) {
        reposted = true
        const body = opts?.atomic ?? (await chequeBody(id, owner))
        if (body?.length) await repostOutsideArcade(runtime.instance.services, id, body)
      }
    }
    console.info(
      `[landing] ${id.slice(0, 12)} still unlanded after ${Date.now() - since}ms — Arcade keeps retrying; checked again at unlock`,
    )
  })()
    .catch((err) => {
      console.warn(`[landing] ${id.slice(0, 12)} watch failed`, err)
    })
    .finally(() => {
      watching.delete(id)
    })
}

async function chequeBody(
  txid: string,
  owner?: BoundAccountKeyScope,
): Promise<number[] | null> {
  try {
    const { signedChequeAtomic } = await import('./signedChequeArchive')
    return signedChequeAtomic(txid, owner)
  } catch {
    return null
  }
}

const RESCUE_MIN_AGE_MS = 10 * 60_000
const RESCUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const RESCUE_MAX = 60
const RESCUE_STATUSES = ['unproven', 'sending', 'unsent']
const HELD_STATUSES = ['nosend']

function rowCreatedMs(raw: unknown): number {
  const at = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''))
  return Number.isFinite(at) ? at : 0
}

/** Outgoing transactions the wallet signed that are not proven yet, oldest first. */
async function unprovenOutgoingSends(
  runtime: WalletRuntime,
  statuses: readonly string[] = RESCUE_STATUSES,
  minAgeMs = RESCUE_MIN_AGE_MS,
): Promise<Array<{ txid: string; at: number }>> {
  const storage = runtime.instance.wallet?.storage as unknown as {
    getAuth?: () => Promise<{ userId?: number }>
    runAsStorageProvider?: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
  }
  if (typeof storage?.runAsStorageProvider !== 'function') return []
  const userId = typeof storage.getAuth === 'function' ? (await storage.getAuth()).userId : undefined
  // One status per query so the cursor rides the status index. A status list
  // with no single status walks the whole store, raw txs and input BEEFs
  // included, on every unlock.
  const rows = await storage.runAsStorageProvider(async (sp) => {
    const find = (sp as {
      findTransactions: (args: unknown) => Promise<Array<{ txid?: string; isOutgoing?: boolean; created_at?: unknown }>>
    }).findTransactions.bind(sp)
    const found = []
    for (const status of statuses) {
      found.push(...(await find({
        partial: { ...(typeof userId === 'number' ? { userId } : {}), status, isOutgoing: true },
        noRawTx: true,
        paged: { limit: 400, offset: 0 },
      })))
    }
    return found
  })
  const now = Date.now()
  return (rows ?? [])
    .map((row) => ({ txid: normalizeTxid(row.txid ?? '') ?? '', at: rowCreatedMs(row.created_at) }))
    .filter((row) => row.txid && now - row.at >= minAgeMs && now - row.at <= RESCUE_MAX_AGE_MS)
    .sort((a, b) => a.at - b.at)
}

/**
 * Pin held cheques the chain already holds. Migrates and item sends file as
 * `nosend` and only Arcade's acceptance pinned them, so one a fallback miner
 * landed stayed app-held for good: change unfundable, no proof request, no
 * Activity row while Collect showed its items. Chain evidence is the only
 * trigger; a held `noSend` the network does not have is never posted here.
 */
async function pinLandedHeldCheques(runtime: WalletRuntime, owner?: BoundAccountKeyScope): Promise<void> {
  if (!(await waitForImportsToSettle(runtime))) return
  const started = Date.now()
  let held: Array<{ txid: string; at: number }>
  try {
    held = await unprovenOutgoingSends(runtime, HELD_STATUSES, UNLOCK_MIN_AGE_MS)
  } catch (err) {
    console.warn('[landing] held cheques skipped — local transactions unreadable', err)
    return
  }
  const { txHadArcadeSubmitContact, txIsArcadeRejected } = await import('./arcadeSubmitGuard')
  const candidates = held
    .filter((row) => !txHadArcadeSubmitContact(row.txid) && !txIsArcadeRejected(row.txid))
    .slice(0, RESCUE_MAX)
  if (candidates.length === 0) return
  const { txExistsOnChain } = await import('./legacyScan')
  const { pinBroadcastLocalTx } = await import('./staleOutputRelease')
  const { removePendingMinerSubmit } = await import('./pendingMinerOutbox')
  const chain = runtime.instance.chain
  let onChain = 0
  let pinned = 0
  let asked = 0
  for (const row of candidates) {
    if (!runtimeIsCurrent(runtime)) return
    let landed = txLanded(row.txid)
    if (!landed) {
      if (asked > 0) await delay(UNLOCK_GAP_MS)
      asked += 1
      landed = (await txExistsOnChain(row.txid, chain).catch(() => null)) === true
      if (landed) noteTxLanded(row.txid)
    }
    if (!landed) continue
    onChain += 1
    removePendingMinerSubmit(row.txid, owner)
    if (!(await waitForSpendRegion()) || !runtimeIsCurrent(runtime)) return
    if (await pinBroadcastLocalTx(row.txid, (await chequeBody(row.txid, owner)) ?? undefined)) pinned += 1
  }
  console.info(
    `[landing] held cheques checked=${candidates.length} onChain=${onChain} pinned=${pinned} done ${Date.now() - started}ms`,
  )
  if (pinned > 0) {
    const { scheduleActivityLedgerRefresh } = await import('./activityLedger')
    scheduleActivityLedgerRefresh()
  }
}

/**
 * Re-post sends a fallback broadcaster accepted and Arcade never saw. Those
 * rounds dropped the outbox row as complete and pinned nothing, so neither
 * the watch nor this pass's pins could ever find them again.
 */
async function rescueUnfollowedSends(runtime: WalletRuntime, owner?: BoundAccountKeyScope): Promise<void> {
  if (!(await waitForImportsToSettle(runtime))) return
  const started = Date.now()
  let unproven: Array<{ txid: string; at: number }>
  try {
    unproven = await unprovenOutgoingSends(runtime)
  } catch (err) {
    console.warn('[landing] rescue skipped — local transactions unreadable', err)
    return
  }
  if (unproven.length === 0) {
    console.info(`[landing] rescue checked=0 unproven=0 done ${Date.now() - started}ms`)
    return
  }
  const { rememberArcadeSubmitContact, txHadArcadeSubmitContact, txIsArcadeRejected } = await import(
    './arcadeSubmitGuard'
  )
  const candidates = unproven
    .filter(
        (row) =>
          !txLanded(row.txid) &&
          !watching.has(row.txid) &&
          !txHadArcadeSubmitContact(row.txid) &&
          !txIsArcadeRejected(row.txid),
      )
      .slice(0, RESCUE_MAX)
  if (candidates.length === 0) {
    console.info(`[landing] rescue checked=0 unproven=${unproven.length} (all followed) done ${Date.now() - started}ms`)
    return
  }
  const { fetchArcadeTxFate, arcadeStatusLanded } = await import('./arcadeV2')
  const { txExistsOnChain } = await import('./legacyScan')
  const chain = runtime.instance.chain
  const tally = { landed: 0, followed: 0, reposted: 0, accepted: 0, unbuilt: 0, left: 0 }
  for (const [i, row] of candidates.entries()) {
    if (i > 0) await delay(UNLOCK_GAP_MS)
    if (!(await waitForImportsToSettle(runtime))) return
    const arcade = toLandingArcade(await fetchArcadeTxFate(chain, row.txid), arcadeStatusLanded)
    const onChain =
      arcade.kind === 'unknown' ? await txExistsOnChain(row.txid, chain).catch(() => null) : null
    const step = decideRescue(arcade, onChain)
    switch (step.kind) {
      case 'landed':
        noteTxLanded(row.txid)
        tally.landed += 1
        break
      case 'follow':
        rememberArcadeSubmitContact(row.txid)
        watchArcadeLanding(row.txid, { owner, since: row.at })
        tally.followed += 1
        break
      case 'leave':
        tally.left += 1
        break
      case 'repost': {
        if (!(await waitForSpendRegion()) || !runtimeIsCurrent(runtime)) return
        let atomic: number[]
        try {
          const { getAtomicBeefBinaryForTxid } = await import('./beefCache')
          atomic = await getAtomicBeefBinaryForTxid(runtime.instance, row.txid)
        } catch (err) {
          tally.unbuilt += 1
          console.warn(
            `[landing] rescue ${row.txid.slice(0, 12)} could not rebuild its package — ${
              err instanceof Error ? err.message : String(err)
            }`.slice(0, 300),
          )
          break
        }
        tally.reposted += 1
        try {
          const { submitAtomicBeefToMiners, minerSubmitKeepOutbox } = await import('./minerSubmit')
          const result = await submitAtomicBeefToMiners(row.txid, atomic, { runtime, owner })
          if (!minerSubmitKeepOutbox(result) || txHadArcadeSubmitContact(row.txid)) tally.accepted += 1
        } catch (err) {
          console.warn(
            `[landing] rescue ${row.txid.slice(0, 12)} re-post refused — ${
              err instanceof Error ? err.message : String(err)
            }`.slice(0, 300),
          )
        }
        break
      }
    }
  }
  console.info(
    `[landing] rescue checked=${candidates.length} landed=${tally.landed} followed=${tally.followed} ` +
      `reposted=${tally.reposted} arcadeAccepted=${tally.accepted} unbuilt=${tally.unbuilt} left=${tally.left} done ${
        Date.now() - started
      }ms`,
  )
}

/**
 * Once per unlocked account: ask about every pinned cheque that never
 * landed, parents first, and fail the ones the chain proves dead. One
 * summary toast, not one per send.
 */
export function scheduleUnlockLandingPass(runtime: WalletRuntime): void {
  if (unlockedRuntimes.has(runtime.runtimeId)) return
  unlockedRuntimes.add(runtime.runtimeId)
  void (async () => {
    await delay(UNLOCK_DELAY_MS)
    const { isRecomposeInFlight } = await import('./recompose')
    while (isRecomposeInFlight()) {
      if (!runtimeIsCurrent(runtime)) return
      await delay(SPEND_POLL_MS * 4)
    }
    if (!(await waitForImportsToSettle(runtime))) return
    const { promotePinnedNoSendProofRequests } = await import('./staleOutputRelease')
    await promotePinnedNoSendProofRequests()
    const started = Date.now()
    const { listArcadeSubmitContacts, txIsArcadeRejected } = await import('./arcadeSubmitGuard')
    const now = Date.now()
    const pins = listArcadeSubmitContacts()
      .filter(
        (pin) =>
          now - pin.at >= UNLOCK_MIN_AGE_MS &&
          !txLanded(pin.txid) &&
          !txIsArcadeRejected(pin.txid) &&
          !watching.has(pin.txid),
      )
      .slice(0, UNLOCK_MAX_PINS)
    const owner = accountKeyScopeFor(runtime.instance)
    const tally = { landed: 0, dead: 0, waiting: 0 }
    for (const [i, pin] of pins.entries()) {
      if (i > 0) await delay(UNLOCK_GAP_MS)
      if (!(await waitForImportsToSettle(runtime))) return
      const round = await checkLanding({
        txid: pin.txid,
        runtime,
        owner,
        atomic: (await chequeBody(pin.txid, owner)) ?? undefined,
        since: pin.at,
        toast: false,
      })
      if (round.fate.kind === 'landed') tally.landed += 1
      else if (round.fate.kind === 'dead') tally.dead += 1
      else {
        tally.waiting += 1
        if (now - pin.at < WATCH_SPAN_MS) {
          watchArcadeLanding(pin.txid, { owner, since: pin.at })
        }
      }
    }
    if (pins.length > 0) {
      console.info(
        `[landing] unlock pass checked=${pins.length} landed=${tally.landed} dead=${tally.dead} waiting=${tally.waiting} done ${
          Date.now() - started
        }ms`,
      )
    }
    if (tally.dead > 0 && runtimeIsCurrent(runtime)) {
      const { toastError } = await import('./toast')
      toastError(
        tally.dead === 1 ? 'A payment did not reach the chain' : `${tally.dead} payments did not reach the chain`,
        'They spent coins that were already spent. Marked not sent; balance corrected.',
      )
    }
    await pinLandedHeldCheques(runtime, owner).catch((err) => {
      console.warn('[landing] held cheque pass failed', err)
    })
    await rescueUnfollowedSends(runtime, owner).catch((err) => {
      console.warn('[landing] rescue failed', err)
    })
  })().catch((err) => {
    console.warn('[landing] unlock pass failed', err)
  })
}
