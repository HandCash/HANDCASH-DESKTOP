/**
 * Prove every coin good before a signed transaction leaves `createAction` /
 * `signAction` — for every path: app payments, BSV and BRC-29 sends, items,
 * market, tokens, burns, sweeps, consolidation.
 *
 * {@link installSpendCertainty} wraps the toolbox instance once at boot, so no
 * caller can sign around it. The check runs inside the caller's exclusive
 * spend region, between signing and the return. The common case costs
 * nothing: coins cleared by the unlock sweep and change of a certified send
 * are answered from {@link ./spendCertainty}. Only coins nobody has vouched
 * for are asked about, and those cost one explorer round (and a short wait on
 * Arcade for an unmined parent this wallet did not certify). Coins another
 * install of this key spent are known from its history snapshot
 * ({@link ./peerDeviceSpends}), read while the toolbox signs.
 *
 * Decision: `kernel/inputCertainty`. Dead coins are retired and the action is
 * signed again, unless the caller named the dead coin itself; unknown coins
 * refuse with a named reason, and the fresh signature is failed locally — it
 * never left this device.
 */
import { Beef, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import {
  judgeInputCertainty,
  retireHitsNamedInput,
  type CertaintyInput,
  type CoinAnswer,
  type InputCertainty,
  type ParentStanding,
  type UncertainReason,
} from './kernel/inputCertainty'
import {
  atomicFromCreateResult,
  PROBE_MS,
  probeOutpointSpends,
  retireSpentInputs,
} from './createActionInputFate'
import { peerSpenderOf, refreshPeerDeviceSpends } from './peerDeviceSpends'
import { canonicalOutpoint, coinCleared, noteTxCertified, txCertified } from './spendCertainty'
import { sealedSpenderOf } from './utxoLockManager'
import { extractTxid } from './txExplorer'
import { normalizeTxid } from './txid'

/** A second, patient ask for coins the first round left unanswered. */
const SECOND_PROBE_MS = 4_000
/** How long an unmined, uncertified parent may take to reach a node. */
const PARENT_WAIT_MS = 3_000
const PARENT_POLL_MS = 750
const MAX_SIGNS = 3
/** Each rebuild retires every dead coin the toolbox picked, so a few clear a stale pool. */
const MAX_FUNDING_REBUILDS = 5
/**
 * How long a signature waits on a snapshot another install just uploaded.
 * Past this the explorer answer stands alone and the read finishes behind.
 */
const PEER_WAIT_MS = 8_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type RefusalReason = UncertainReason | 'still-dead' | 'input-spent'

export class InputsUnverifiedError extends Error {
  readonly code = 'INPUTS_UNVERIFIED'
  constructor(
    readonly reason: RefusalReason,
    message: string,
    /** Outpoints found spent elsewhere, when that is why it refused. */
    readonly dead: readonly string[] = [],
  ) {
    super(message)
    this.name = 'InputsUnverifiedError'
  }
}

function refusalMessage(reason: RefusalReason): string {
  switch (reason) {
    case 'parent-unlanded':
      return 'Your previous payment has not reached the network yet. Nothing was sent — try again in a few seconds.'
    case 'explorer-silent':
      return 'Could not confirm your coins are unspent — the network did not answer. Nothing was sent — try again.'
    case 'still-dead':
      return 'Some of your coins were already spent; the wallet is clearing them. Nothing was sent — try again.'
    case 'input-spent':
      return 'A coin this action spends was already spent. Nothing was sent.'
    default:
      return 'This payment could not be checked before sending. Nothing was sent — try again.'
  }
}

type InputOrigin = { outpoint: string; parent: string; chained: boolean }

function inputOrigins(atomic: number[] | null, inputs: string[]): InputOrigin[] {
  let beef: Beef | null = null
  if (atomic?.length) {
    try {
      beef = Beef.fromBinary(atomic)
    } catch {
      beef = null
    }
  }
  return inputs.map((outpoint) => {
    const parent = normalizeTxid(outpoint.split(/[._:]/)[0] ?? '') ?? ''
    const node = beef?.findTxid(parent)
    return {
      outpoint,
      parent,
      chained: !!node && !node.isTxidOnly && !!node.tx && !node.hasProof,
    }
  })
}

async function parentStanding(parent: string, chain: Chain): Promise<ParentStanding> {
  const { txIsArcadeRejected } = await import('./arcadeSubmitGuard')
  if (txIsArcadeRejected(parent)) return 'rejected'
  const { txLanded, noteTxLanded } = await import('./arcadeLanding')
  if (txCertified(parent)) return 'certified'
  if (txLanded(parent)) return 'landed'
  const { fetchArcadeTxFate, arcadeStatusLanded } = await import('./arcadeV2')
  const deadline = Date.now() + PARENT_WAIT_MS
  for (;;) {
    const left = deadline - Date.now()
    const fate = await Promise.race([
      fetchArcadeTxFate(chain, parent),
      delay(Math.max(left, 250)).then(() => ({ kind: 'unknown' as const })),
    ])
    if (fate.kind === 'accepted' && arcadeStatusLanded(fate.status)) {
      noteTxLanded(parent)
      return 'landed'
    }
    if (fate.kind === 'rejected') return 'rejected'
    if (fate.kind === 'unknown') {
      const { txExistsOnChain } = await import('./legacyScan')
      if ((await txExistsOnChain(parent, chain).catch(() => null)) === true) {
        noteTxLanded(parent)
        return 'landed'
      }
    }
    if (Date.now() + PARENT_POLL_MS >= deadline) return 'unlanded'
    await delay(PARENT_POLL_MS)
  }
}

async function coinAnswers(
  outpoints: string[],
  txid: string,
  chain: Chain,
): Promise<{ answers: Map<string, CoinAnswer>; asked: number }> {
  const answers = new Map<string, CoinAnswer>()
  let ask = outpoints.filter((outpoint) => {
    if (!coinCleared(outpoint)) return true
    answers.set(outpoint, { kind: 'cleared' })
    return false
  })
  const asked = ask.length
  for (const timeoutMs of [PROBE_MS, SECOND_PROBE_MS]) {
    if (ask.length === 0) break
    const probes = await probeOutpointSpends(ask, txid, chain, timeoutMs)
    const silent: string[] = []
    for (const outpoint of ask) {
      const probe = probes.get(outpoint)
      if (probe?.kind === 'unspent') answers.set(outpoint, { kind: 'cleared' })
      else if (probe?.kind === 'spent') {
        answers.set(outpoint, { kind: 'spent', spender: probe.spender })
      } else silent.push(outpoint)
    }
    ask = silent
  }
  for (const outpoint of ask) answers.set(outpoint, { kind: 'unknown' })
  return { answers, asked }
}

export type JudgedSign = { txid: string; inputs: string[]; verdict: InputCertainty }

/** Judge the coins a transaction spends — freshly signed, or unsigned from a signable. */
export async function judgeSignedInputs(
  result: unknown,
  chain: Chain,
): Promise<JudgedSign | null> {
  const txid = extractTxid(result)?.toLowerCase()
  if (!txid) return null
  const started = Date.now()
  const atomic = atomicFromCreateResult(result)
  const { inputOutpointsForSignedTx } = await import('./signedTxInputs')
  const inputs = await inputOutpointsForSignedTx(txid, atomic ?? undefined)
  if (inputs.length === 0) {
    return { txid, inputs, verdict: { kind: 'uncertain', reason: 'unreadable', outpoints: [] } }
  }

  const origins = inputOrigins(atomic, inputs)
  const peerSpent = new Map<string, string>()
  // A certified parent vouches that its change exists, not that it is still
  // unspent. A coin this wallet sealed under another of its own transactions
  // is spent whatever the parent's standing.
  let sealed = 0
  for (const o of origins) {
    const own = sealedSpenderOf(o.outpoint)
    if (own && own !== txid) {
      peerSpent.set(o.outpoint, own)
      sealed += 1
      continue
    }
    const spender = peerSpenderOf(o.outpoint)
    if (spender) peerSpent.set(o.outpoint, spender)
  }
  const open = origins.filter((o) => !peerSpent.has(o.outpoint))
  const vouched = (parent: string) => txCertified(parent)
  const chainedParents = [
    ...new Set(open.filter((o) => o.chained || vouched(o.parent)).map((o) => o.parent)),
  ]
  const minedCoins = open
    .filter((o) => !o.chained && !vouched(o.parent))
    .map((o) => o.outpoint)

  const [standings, { answers, asked }] = await Promise.all([
    Promise.all(chainedParents.map(async (p) => [p, await parentStanding(p, chain)] as const)),
    coinAnswers(minedCoins, txid, chain),
  ])
  const standingOf = new Map(standings)

  const judged: CertaintyInput[] = origins.map((o) => {
    const peer = peerSpent.get(o.outpoint)
    if (peer) return { outpoint: o.outpoint, origin: 'mined', answer: { kind: 'spent', spender: peer } }
    return standingOf.has(o.parent)
      ? { outpoint: o.outpoint, origin: 'chained', parent: o.parent, standing: standingOf.get(o.parent)! }
      : { outpoint: o.outpoint, origin: 'mined', answer: answers.get(o.outpoint) ?? { kind: 'unknown' } }
  })
  const verdict = judgeInputCertainty(judged)
  const ms = Date.now() - started
  if (ms >= 250 || verdict.kind !== 'certain') {
    console.info(
      `[certainty] ${txid.slice(0, 12)} ${verdict.kind}${
        verdict.kind === 'uncertain' ? ` reason=${verdict.reason}` : ''
      } inputs=${inputs.length} asked=${asked} parents=${chainedParents.length} peer=${peerSpent.size - sealed} sealed=${sealed} done ${ms}ms`,
    )
  }
  return { txid, inputs, verdict }
}

async function retireDeadInputs(
  txid: string,
  verdict: Extract<InputCertainty, { kind: 'retire' }>,
  chain: Chain,
): Promise<void> {
  const { failUnsentLocalTx } = await import('./staleOutputRelease')
  if (verdict.spends.length > 0) {
    await retireSpentInputs(txid, verdict.spends, chain, { freshlySigned: true })
  } else {
    await failUnsentLocalTx(txid, { force: true, noDescendants: true })
  }
  if (verdict.deadParents.length === 0) return
  const { noteArcadeRejectedTx } = await import('./arcadeSubmitGuard')
  for (const parent of verdict.deadParents) {
    noteArcadeRejectedTx(parent)
    await failUnsentLocalTx(parent, { force: true })
    console.warn(`[certainty] retired ${parent.slice(0, 12)} — Arcade rejected it; its change is gone`)
  }
  const { bumpBalanceAfterHeal } = await import('./session')
  bumpBalanceAfterHeal()
}

export type CertaintyOptions = {
  /** Outpoints the caller named in `inputs`. A dead one refuses rather than re-signing. */
  named?: ReadonlySet<string>
  /** False when the signature fixes every input (`signAction`): any dead coin refuses. */
  resign?: boolean
  onResign?: () => void
}

/**
 * Sign, then prove every coin good before returning. Dead coins are retired
 * and the action signed again; coins nobody can vouch for refuse it.
 */
export async function signWithCertainInputs<T>(
  sign: () => Promise<T>,
  chain: Chain,
  opts: CertaintyOptions = {},
): Promise<T> {
  const peerRead = refreshPeerDeviceSpends()
  let signed = await sign()
  const firstTxid = extractTxid(signed)?.toLowerCase()
  if (!firstTxid || txCertified(firstTxid)) return signed
  await Promise.race([peerRead, delay(PEER_WAIT_MS)])
  for (let attempt = 1; ; attempt += 1) {
    const judged = await judgeSignedInputs(signed, chain)
    if (!judged) return signed
    const { txid, inputs, verdict } = judged
    if (verdict.kind === 'certain') {
      noteTxCertified(txid, inputs)
      return signed
    }
    if (verdict.kind === 'retire') {
      await retireDeadInputs(txid, verdict, chain)
      if (opts.resign === false || retireHitsNamedInput(verdict, opts.named ?? new Set())) {
        console.warn(`[certainty] ${txid.slice(0, 12)} refused reason=input-spent — nothing sent`)
        throw new InputsUnverifiedError(
          'input-spent',
          refusalMessage('input-spent'),
          verdict.spends.map((s) => s.outpoint),
        )
      }
      if (attempt >= MAX_SIGNS) {
        throw new InputsUnverifiedError('still-dead', refusalMessage('still-dead'))
      }
      console.warn(`[certainty] ${txid.slice(0, 12)} signing again with live coins`)
      opts.onResign?.()
      signed = await sign()
      continue
    }
    const { failUnsentLocalTx } = await import('./staleOutputRelease')
    await failUnsentLocalTx(txid, { force: true, noDescendants: true })
    console.warn(
      `[certainty] ${txid.slice(0, 12)} refused reason=${verdict.reason} coins=${verdict.outpoints.length} — nothing sent`,
    )
    throw new InputsUnverifiedError(verdict.reason, refusalMessage(verdict.reason))
  }
}

/**
 * Judge a signable's inputs before `signAction` signs them. The reference
 * fixes every input, so a dead or unanswered coin aborts the action — and an
 * inline broadcast (`acceptDelayedBroadcast: false`) never starts.
 */
export async function certifyBeforeSigning(
  unsigned: number[],
  chain: Chain,
  abort: () => Promise<void>,
): Promise<string[]> {
  let subject = ''
  try {
    subject = Transaction.fromAtomicBEEF(Uint8Array.from(unsigned)).id('hex')
  } catch {
    subject = ''
  }
  await Promise.race([refreshPeerDeviceSpends(), delay(PEER_WAIT_MS)])
  const judged = subject ? await judgeSignedInputs({ txid: subject, tx: unsigned }, chain) : null
  const verdict: InputCertainty = judged?.verdict ?? {
    kind: 'uncertain',
    reason: 'unreadable',
    outpoints: [],
  }
  if (verdict.kind === 'certain') return judged!.inputs
  await abort()
  if (verdict.kind === 'retire') {
    await retireDeadInputs(subject, verdict, chain)
    console.warn(`[certainty] ${subject.slice(0, 12)} refused reason=input-spent — aborted before signing`)
    throw new InputsUnverifiedError(
      'input-spent',
      refusalMessage('input-spent'),
      verdict.spends.map((s) => s.outpoint),
    )
  }
  console.warn(
    `[certainty] ${subject.slice(0, 12) || 'signable'} refused reason=${verdict.reason} — aborted before signing`,
  )
  throw new InputsUnverifiedError(verdict.reason, refusalMessage(verdict.reason))
}

function signableOf(result: unknown): { reference: string; tx: number[] } | null {
  const s =
    result && typeof result === 'object'
      ? (result as { signableTransaction?: { reference?: unknown; tx?: unknown } }).signableTransaction
      : undefined
  if (!s || typeof s.reference !== 'string') return null
  const tx =
    s.tx instanceof Uint8Array ? Array.from(s.tx) : Array.isArray(s.tx) ? (s.tx as number[]) : null
  return tx?.length ? { reference: s.reference, tx } : null
}

/**
 * A signable is built over funding the toolbox chose, and the caller signs its
 * own inputs over that exact transaction. A dead funding coin found later, in
 * `signAction`, can only refuse. So the funding is judged here, before the
 * caller sees the signable: a dead coin the caller did not name is retired and
 * the action built again over live coins. Anything else is left for
 * {@link certifyBeforeSigning} to refuse with its named reason.
 */
export async function rebuildOverDeadFunding<T>(
  create: () => Promise<T>,
  first: T,
  chain: Chain,
  opts: {
    named: ReadonlySet<string>
    abort: (reference: string) => Promise<void>
  },
): Promise<T> {
  let result = first
  const retired = new Set<string>()
  for (let rebuilds = 0; rebuilds < MAX_FUNDING_REBUILDS; rebuilds += 1) {
    const signable = signableOf(result)
    if (!signable) return result
    let subject = ''
    try {
      subject = Transaction.fromAtomicBEEF(Uint8Array.from(signable.tx)).id('hex')
    } catch {
      return result
    }
    const judged = await judgeSignedInputs({ txid: subject, tx: signable.tx }, chain)
    const verdict = judged?.verdict
    if (verdict?.kind !== 'retire' || retireHitsNamedInput(verdict, opts.named)) return result
    // Building again cannot help once storage hands back a coin it was told to
    // hide; the caller's certify step refuses it with its named reason.
    const again = verdict.spends.map((s) => s.outpoint).filter((outpoint) => retired.has(outpoint))
    if (again.length > 0) {
      console.warn(
        `[certainty] ${subject.slice(0, 12)} retired funding chosen again (${again.join(', ')}) — not building again`,
      )
      return result
    }
    for (const s of verdict.spends) retired.add(s.outpoint)
    await opts.abort(signable.reference)
    await retireDeadInputs(subject, verdict, chain)
    console.warn(
      `[certainty] ${subject.slice(0, 12)} funding spent elsewhere — building again over live coins (${verdict.spends
        .map((s) => s.outpoint)
        .join(', ')})`,
    )
    result = await create()
  }
  return result
}

function namedInputs(args: unknown): Set<string> {
  const named = new Set<string>()
  const list = args && typeof args === 'object' ? (args as { inputs?: unknown }).inputs : null
  if (!Array.isArray(list)) return named
  for (const input of list) {
    const outpoint = canonicalOutpoint(String((input as { outpoint?: unknown } | null)?.outpoint ?? ''))
    if (outpoint) named.add(outpoint)
  }
  return named
}

function optionsOf(args: unknown): Record<string, unknown> {
  const options = args && typeof args === 'object' ? (args as { options?: unknown }).options : null
  return options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
}

/** The toolbox posts to miners inside this very call; a verdict after it cannot stop anything. */
function createBroadcastsInline(args: unknown): boolean {
  const o = optionsOf(args)
  return o.acceptDelayedBroadcast === false && o.noSend !== true && o.signAndProcess !== false
}

const SIGNABLE_MAX = 64
/** Unsigned Atomic BEEF of each open signable, by reference. */
const signables = new Map<string, number[]>()

function rememberSignable(result: unknown): void {
  const s =
    result && typeof result === 'object'
      ? (result as { signableTransaction?: { reference?: unknown; tx?: unknown } }).signableTransaction
      : undefined
  if (!s || typeof s.reference !== 'string') return
  const tx =
    s.tx instanceof Uint8Array ? Array.from(s.tx) : Array.isArray(s.tx) ? (s.tx as number[]) : null
  if (!tx?.length) return
  signables.set(s.reference, tx)
  if (signables.size > SIGNABLE_MAX) signables.delete(signables.keys().next().value!)
}

const INSTALLED = new WeakSet<object>()

/**
 * Every signature this wallet makes is judged. Install once per wallet boot,
 * on the toolbox instance itself, so pinned proxies and every caller see the
 * gated methods.
 *
 * - `createAction` signs, then {@link signWithCertainInputs} judges before
 *   returning (delayed broadcast: nothing has left the device yet).
 * - `signAction` is judged before signing, from the signable its
 *   `createAction` returned ({@link certifyBeforeSigning}).
 */
export function installSpendCertainty(wallet: Wallet, chain: Chain): void {
  if (INSTALLED.has(wallet)) return
  INSTALLED.add(wallet)
  const create = wallet.createAction.bind(wallet)
  const createGated: Wallet['createAction'] = async (args, originator) => {
    if (createBroadcastsInline(args)) {
      const result = await create(args, originator)
      const txid = extractTxid(result)
      if (txid) console.warn(`[certainty] ${txid.slice(0, 12)} unjudged — createAction broadcast inline`)
      return result
    }
    const named = namedInputs(args)
    let result = await signWithCertainInputs(() => create(args, originator), chain, { named })
    if (abortAct && signableOf(result)) {
      result = await rebuildOverDeadFunding(() => create(args, originator), result, chain, {
        named,
        abort: async (reference) => {
          await abortAct({ reference }, originator).catch((err: unknown) => {
            console.warn('[certainty] abort before rebuild failed', err)
          })
        },
      })
    }
    rememberSignable(result)
    return result
  }
  const abortAct = typeof wallet.abortAction === 'function' ? wallet.abortAction.bind(wallet) : null
  ;(wallet as { createAction: Wallet['createAction'] }).createAction = createGated
  if (typeof wallet.signAction !== 'function') return
  const signAct = wallet.signAction.bind(wallet)
  const signGated: Wallet['signAction'] = async (args, originator) => {
    const reference = typeof args?.reference === 'string' ? args.reference : ''
    const unsigned = signables.get(reference)
    if (unsigned) {
      signables.delete(reference)
      const inputs = await certifyBeforeSigning(unsigned, chain, async () => {
        await abortAct?.({ reference }, originator).catch((err: unknown) => {
          console.warn('[certainty] abort of refused signable failed', err)
        })
      })
      const signed = await signAct(args, originator)
      const txid = extractTxid(signed)
      if (txid) noteTxCertified(txid, inputs)
      return signed
    }
    if (optionsOf(args).acceptDelayedBroadcast === false) {
      const signed = await signAct(args, originator)
      const txid = extractTxid(signed)
      if (txid) console.warn(`[certainty] ${txid.slice(0, 12)} unjudged — signAction broadcast inline`)
      return signed
    }
    return signWithCertainInputs(() => signAct(args, originator), chain, { resign: false })
  }
  ;(wallet as { signAction: Wallet['signAction'] }).signAction = signGated
}

export function resetSignablesForTests(): void {
  signables.clear()
}
