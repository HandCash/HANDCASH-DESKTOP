/**
 * Automatic account movement between installs of one vault (draft BRC-249).
 *
 * - **Device to device.** Installs of the vault keep a data channel to each
 *   other (`vaultLink.ts`). A move asks the holding device over it and the
 *   accept comes back over it; the box carries a request only when no link
 *   to that device opens.
 * - **Holder service.** While unlocked, the vault link and the holding
 *   channel (box `account-holding` on the account's own key) of every account
 *   held here are served every {@link HOLDING_SERVE_MS}. A valid release
 *   request, from either, is accepted without asking and the account
 *   released; the open account merges a handover from a displaced install.
 *   Each tick also keeps local holding fresh (`holdingFreshness.ts`).
 * - **Gap check.** {@link ensureHoldingFresh} runs on the spend path and reads
 *   the holder record only when the account is not fresh: once per gap.
 * - **Move here.** {@link moveAccountHere} runs `accountMoveMachine`: ask the
 *   holder, take on release, force the take when it does not answer.
 */
import { createActor, fromCallback, fromPromise, toPromise } from 'xstate'
import type { AccountKeys } from './accountHolding'
import {
  HOLDING_BOX,
  REQUEST_MAX_AGE_MS,
  decideRequestAnswer,
  parseHoldingMessage,
  signReleaseAccept,
  signReleaseRequest,
} from './accountRelease'
import { accountMoveMachine, type AccountMovePhase, type MoveFailure, type RecordView } from './accountMoveMachine'
import { appendAppLog } from './appLog'
import { isHoldingFresh, noteHoldingGap, noteHoldingServed } from './holdingFreshness'
import type { ListedMessage } from './messageTransport'
import {
  checkVaultAccountHoldings,
  releaseActiveVaultAccount,
  releaseIdleVaultAccount,
  takeVaultAccount,
  type HolderIo,
} from './vaultAccountHolding'
import { holdingOf, identityKeyForAccount, isHeldHere, readVaultAccounts, rootKeyHexForAccount } from './vaultAccounts'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'
import {
  dialVaultLink,
  onVaultLinkMessage,
  sendOverVaultLink,
  serveVaultLink,
  startVaultLink,
  stopVaultLink,
} from './vaultLink'
import { getWalletRuntime, runtimeIsCurrent } from './walletRuntime'

/** How often the holder reads its holding channel; well inside the answer window. */
export const HOLDING_SERVE_MS = 5_000
/** How often a mover polls for the accept and the record. */
const MOVE_POLL_MS = 1_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The box operations a move needs; `messageTransport.ts` in the app. */
export type HoldingChannel = {
  list: (rootKeyHex: string) => Promise<ListedMessage[] | null>
  send: (rootKeyHex: string, body: string) => Promise<void>
  acknowledge: (rootKeyHex: string, messageIds: string[]) => Promise<void>
}

async function defaultChannel(): Promise<HoldingChannel> {
  const t = await import('./messageTransport')
  return {
    list: (rootKeyHex) => t.listOwnBox(rootKeyHex, HOLDING_BOX),
    send: (rootKeyHex, body) => t.sendToOwnBox(rootKeyHex, HOLDING_BOX, body),
    acknowledge: (rootKeyHex, ids) => t.acknowledgeOwnBox(rootKeyHex, HOLDING_BOX, ids),
  }
}

/** Device-to-device link to the other installs of the vault; `vaultLink.ts` in the app. */
export type DirectLink = {
  /** True once a link to `device` is open, waiting a bounded time for it. */
  dial: (device: string) => Promise<boolean>
  /** `box` when no link to `device` acked the frame. */
  send: (device: string, body: string) => Promise<'direct' | 'box'>
  subscribe: (listener: (body: string, device: string) => void) => () => void
}

const defaultLink: DirectLink = {
  dial: (device) => dialVaultLink(device),
  send: sendOverVaultLink,
  subscribe: onVaultLinkMessage,
}

async function defaultHolderIo(): Promise<HolderIo> {
  const [{ readHolderRecord, writeHolderRecord }, { getOrCreateDeviceId }] = await Promise.all([
    import('./accountHolderRecord'),
    import('./deviceWallets'),
  ])
  return { deviceId: getOrCreateDeviceId, read: readHolderRecord, write: writeHolderRecord }
}

function keysFor(master: VaultMaster, index: number): AccountKeys {
  return { identityKey: identityKeyForAccount(master, index), rootKeyHex: rootKeyHexForAccount(master, index) }
}

// ── Move here ────────────────────────────────────────────────────────────────

export type MoveResult =
  | { kind: 'moved'; forced: boolean }
  | { kind: 'failed'; failure: MoveFailure; message: string }

const FAILURE_COPY: Record<MoveFailure, string> = {
  'host-unreachable': 'HandCash could not reach your backup host to move this wallet. Check the connection and try again.',
  'host-unsupported': 'Your backup host cannot record which device holds a wallet, so it cannot move.',
  'channel-unreachable': 'HandCash could not ask your other device for this wallet. Check the connection and try again.',
  'take-unavailable': 'HandCash could not move this wallet here. Check the connection and try again.',
  'kept-changing': 'Another device kept taking this wallet. Try again.',
}

async function viewRecord(io: HolderIo, keys: AccountKeys, deviceId: string): Promise<RecordView> {
  const read = await io.read(keys)
  switch (read.kind) {
    case 'unreachable':
      return { kind: 'unreachable', reason: read.reason }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'absent':
      return { kind: 'absent' }
    case 'record': {
      const { record } = read
      if (record.state === 'released') return { kind: 'released', seq: record.seq }
      if (record.deviceId === deviceId) return { kind: 'ours', seq: record.seq }
      return { kind: 'held', seq: record.seq, deviceId: record.deviceId }
    }
  }
}

function poll(every: number, tick: () => Promise<boolean | void>): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = async () => {
    if (stopped) return
    const done = await tick().catch(() => false)
    if (!stopped && done !== true) timer = setTimeout(run, every)
  }
  void run()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/**
 * Move account `index` here: ask the holder to release it, take it when it
 * does, and take it anyway when the holder does not answer in time. The
 * caller then opens the account with `arrived`, which merges its history
 * backup before anything spends.
 */
export async function moveAccountHere(args: {
  master: VaultMaster
  index: number
  onPhase?: (phase: AccountMovePhase) => void
  io?: HolderIo
  channel?: HoldingChannel
  link?: DirectLink | null
  pollMs?: number
}): Promise<MoveResult> {
  const started = Date.now()
  const { master, index } = args
  const io = args.io ?? (await defaultHolderIo())
  const channel = args.channel ?? (await defaultChannel())
  const link = args.link === undefined ? defaultLink : args.link
  const pollMs = args.pollMs ?? MOVE_POLL_MS
  const deviceId = io.deviceId()
  const keys = keysFor(master, index)
  const sentRequests: string[] = []

  const machine = accountMoveMachine.provide({
    actors: {
      readRecord: fromPromise(() => viewRecord(io, keys, deviceId)),
      dialLink: fromPromise(async ({ input }: { input: { device: string } }) => {
        const open = link ? await link.dial(input.device) : false
        appendAppLog('info', `[account-holding] move a${index}: link to ${input.device.slice(0, 8)} ${open ? 'open' : 'not open'}`)
        return open
      }),
      sendDirect: fromPromise(async ({ input }: { input: { seq: number; device: string } }) => {
        const request = signReleaseRequest(keys.rootKeyHex, { deviceId, seq: input.seq })
        if (!link || (await link.send(input.device, JSON.stringify(request))) !== 'direct') {
          throw new Error('the holding device did not acknowledge')
        }
        appendAppLog('info', `[account-holding] move a${index}: asked holder device to device (seq=${input.seq})`)
        return { nonce: request.nonce }
      }),
      sendBox: fromPromise(async ({ input }: { input: { seq: number } }) => {
        const request = signReleaseRequest(keys.rootKeyHex, { deviceId, seq: input.seq })
        await channel.send(keys.rootKeyHex, JSON.stringify(request))
        sentRequests.push(request.nonce)
        appendAppLog('info', `[account-holding] move a${index}: asked holder through the box (seq=${input.seq})`)
        return { nonce: request.nonce }
      }),
      take: fromPromise(({ input }: { input: { force: boolean } }) =>
        takeVaultAccount({ master, index, force: input.force, io }),
      ),
      watchAccept: fromCallback(({ sendBack, input }: { sendBack: (e: { type: 'ACCEPTED' }) => void; input: { nonce: string } }) => {
        let accepted = false
        const isOurs = (body: string) => {
          const msg = parseHoldingMessage(body, keys.identityKey)
          return msg?.type === 'release-accept' && msg.nonce === input.nonce && msg.deviceId !== deviceId
        }
        const accept = () => {
          if (accepted) return
          accepted = true
          sendBack({ type: 'ACCEPTED' })
        }
        // The holder answers over the link when it can, through the box otherwise.
        const unsubscribe = link?.subscribe((body) => {
          if (isOurs(body)) accept()
        })
        const stop = poll(pollMs, async () => {
          if (accepted) return true
          const messages = await channel.list(keys.rootKeyHex)
          for (const m of messages ?? []) {
            if (!isOurs(m.body)) continue
            await channel.acknowledge(keys.rootKeyHex, [m.messageId])
            accept()
            return true
          }
        })
        return () => {
          unsubscribe?.()
          stop()
        }
      }),
      watchRecord: fromCallback(({ sendBack }: { sendBack: (e: { type: 'RECORD'; view: RecordView }) => void }) =>
        poll(pollMs, async () => {
          sendBack({ type: 'RECORD', view: await viewRecord(io, keys, deviceId) })
        }),
      ),
    },
  })

  const actor = createActor(machine)
  actor.subscribe((snapshot) => {
    if (snapshot.status === 'active') args.onPhase?.(snapshot.value as AccountMovePhase)
  })
  actor.start()
  const output = await toPromise(actor)
  await retireOwnRequests(channel, keys, deviceId, sentRequests)

  const ms = Date.now() - started
  if (output.kind === 'moved') {
    appendAppLog('info', `[account-holding] move a${index} done ${ms}ms${output.forced ? ' (holder offline, forced)' : ''}`)
    return output
  }
  appendAppLog(
    'warn',
    `[account-holding] move a${index} failed ${ms}ms: ${output.failure}${output.detail ? ` — ${output.detail}` : ''}`,
  )
  return { kind: 'failed', failure: output.failure, message: FAILURE_COPY[output.failure] }
}

/** This move's requests are spent either way; nobody else would remove them. */
async function retireOwnRequests(
  channel: HoldingChannel,
  keys: AccountKeys,
  deviceId: string,
  nonces: string[],
): Promise<void> {
  if (!nonces.length) return
  const messages = await channel.list(keys.rootKeyHex).catch(() => null)
  const ids = (messages ?? []).flatMap((m) => {
    const msg = parseHoldingMessage(m.body, keys.identityKey)
    return msg?.type === 'release-request' && msg.deviceId === deviceId && nonces.includes(msg.nonce)
      ? [m.messageId]
      : []
  })
  await channel.acknowledge(keys.rootKeyHex, ids).catch(() => {})
}

// ── Holder service ───────────────────────────────────────────────────────────

/** What one read of the holding channel needs from the running wallet. */
export type ServeTarget = {
  master: VaultMaster
  index: number
  identityKey: string
  rootKeyHex: string
  deviceId: string
  /** Release the account (flush history, write `released`). */
  release: () => Promise<void>
  /** Merge a complete handover document; null while the account is not open here. */
  merge: ((json: string) => Promise<void>) | null
  /** Read the record again: a request named a newer seq than we know. */
  recheck: () => void
  open: (body: string) => string | null
}

export type ServeOutcome =
  | { kind: 'idle' }
  | { kind: 'not-holder' }
  | { kind: 'unreachable' }
  | { kind: 'released'; to: string }
  | { kind: 'release-failed'; reason: string }

function localHoldingOf(target: ServeTarget) {
  const account = readVaultAccounts(vaultIdentityKey(target.master)).accounts.find((a) => a.index === target.index)
  return account ? holdingOf(account) : null
}

/** Answer the requester device to device when a link to it acks, else through the box. */
function replyTo(target: ServeTarget, device: string, channel: HoldingChannel, link: DirectLink | null) {
  return async (body: string): Promise<'direct' | 'box'> => {
    if (link && (await link.send(device, body)) === 'direct') return 'direct'
    await channel.send(target.rootKeyHex, body)
    return 'box'
  }
}

/** Accept a release request, then release. The accept goes out before anything else can fail. */
async function acceptAndRelease(
  target: ServeTarget,
  request: { nonce: string; deviceId: string; via: 'direct' | 'box' },
  reply: (body: string) => Promise<'direct' | 'box'>,
): Promise<ServeOutcome> {
  const accept = signReleaseAccept(target.rootKeyHex, { deviceId: target.deviceId, nonce: request.nonce })
  const answered = await reply(JSON.stringify(accept))
  appendAppLog(
    'info',
    `[account-holding] a${target.index} release requested by ${request.deviceId.slice(0, 8)} (${request.via}) — accepted (${answered})`,
  )
  try {
    await target.release()
    return { kind: 'released', to: request.deviceId }
  } catch (error) {
    appendAppLog('warn', `[account-holding] a${target.index} release after accept failed: ${messageOf(error)}`)
    return { kind: 'release-failed', reason: messageOf(error) }
  }
}

/** Read the holding channel once and act on it. */
export async function serveHoldingChannel(
  target: ServeTarget,
  channel: HoldingChannel,
  now = Date.now(),
  link: DirectLink | null = null,
): Promise<ServeOutcome> {
  const local = localHoldingOf(target)
  if (local?.kind !== 'here') return { kind: 'not-holder' }
  const messages = await channel.list(target.rootKeyHex)
  if (messages == null) return { kind: 'unreachable' }

  const { receiveHandovers } = await import('./accountHandover')
  const handovers = await receiveHandovers({
    identityKey: target.identityKey,
    deviceId: target.deviceId,
    messages,
    now,
    inbox: {
      open: target.open,
      merge: target.merge,
      acknowledge: (ids) => channel.acknowledge(target.rootKeyHex, ids),
    },
  })

  const consumed: string[] = []
  let accepted: { messageId: string; nonce: string; deviceId: string } | null = null
  for (const m of messages) {
    if (handovers.has(m.messageId)) continue
    const msg = parseHoldingMessage(m.body, target.identityKey)
    if (msg?.type !== 'release-request') continue
    if (msg.deviceId === target.deviceId) {
      if (now - msg.at > REQUEST_MAX_AGE_MS) consumed.push(m.messageId)
      continue
    }
    const answer = decideRequestAnswer({ request: msg, local, now })
    if (answer.kind === 'accept') {
      accepted ??= { messageId: m.messageId, nonce: msg.nonce, deviceId: msg.deviceId }
      if (accepted.messageId !== m.messageId) consumed.push(m.messageId)
    } else if (answer.kind === 'drop') {
      consumed.push(m.messageId)
    } else if (answer.reason === 'newer-record') {
      target.recheck()
    }
  }

  if (!accepted) {
    if (consumed.length) await channel.acknowledge(target.rootKeyHex, consumed)
    return { kind: 'idle' }
  }
  const reply = replyTo(target, accepted.deviceId, channel, link)
  return acceptAndRelease(target, { ...accepted, via: 'box' }, async (body) => {
    const answered = await reply(body)
    await channel.acknowledge(target.rootKeyHex, [...consumed, accepted.messageId])
    return answered
  })
}

/**
 * A release request that arrived over the vault link from `fromDevice`. The
 * signed request must name the device the link authenticated.
 */
export async function answerDirectRequest(
  target: ServeTarget,
  body: string,
  fromDevice: string,
  channel: HoldingChannel,
  link: DirectLink | null,
  now = Date.now(),
): Promise<ServeOutcome> {
  const local = localHoldingOf(target)
  if (local?.kind !== 'here') return { kind: 'not-holder' }
  const msg = parseHoldingMessage(body, target.identityKey)
  if (msg?.type !== 'release-request' || msg.deviceId !== fromDevice || msg.deviceId === target.deviceId) {
    return { kind: 'idle' }
  }
  const answer = decideRequestAnswer({ request: msg, local, now })
  if (answer.kind === 'leave' && answer.reason === 'newer-record') target.recheck()
  if (answer.kind !== 'accept') return { kind: 'idle' }
  return acceptAndRelease(target, { nonce: msg.nonce, deviceId: msg.deviceId, via: 'direct' }, replyTo(target, msg.deviceId, channel, link))
}

let serveTimer: ReturnType<typeof setInterval> | null = null
let serving = false
let gapListener: (() => void) | null = null
let directListener: (() => void) | null = null
/** Ticks and link requests run one at a time, so two requests never release one account twice. */
let serial: Promise<unknown> = Promise.resolve()

function inSerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = serial.then(fn, fn)
  serial = run.catch(() => {})
  return run
}

/** What serving needs from the running wallet; null while no vault is open. */
async function serveContext() {
  const runtime = getWalletRuntime()
  const active = runtime?.instance
  if (!runtime || !active?.vaultMaster) return null
  const [{ getOrCreateDeviceId }, transport, history, deviceSync, session] = await Promise.all([
    import('./deviceWallets'),
    import('./messageTransport'),
    import('./historyBackup'),
    import('./deviceSync'),
    import('./session'),
  ])
  const master = active.vaultMaster
  const deviceId = getOrCreateDeviceId()
  startVaultLink({ master, deviceId })
  const targetFor = (index: number): ServeTarget => {
    const rootKeyHex = rootKeyHexForAccount(master, index)
    const open = index === active.accountIndex
    return {
      master,
      index,
      identityKey: identityKeyForAccount(master, index),
      rootKeyHex,
      deviceId,
      release: open ? () => releaseActiveVaultAccount(runtime) : () => releaseIdleVaultAccount(master, index),
      merge: open
        ? async (json) => {
            await history.mergeHandoverDocument(runtime, json)
            deviceSync.markHistoryBackupDirty()
            deviceSync.scheduleHistoryBackupPush('handover')
            session.bumpBalanceAfterHeal()
            void import('./pendingBrc29Outbox').then(({ deliverOwedBrc29Notices }) => deliverOwedBrc29Notices(runtime))
          }
        : null,
      recheck: () => {
        void checkVaultAccountHoldings(master, { indices: [index] }).catch(() => {})
      },
      open: (body) => transport.openFromSelf(rootKeyHex, body),
    }
  }
  const accounts = readVaultAccounts(vaultIdentityKey(master)).accounts
  return {
    runtime,
    master,
    deviceId,
    activeIndex: active.accountIndex,
    targetFor,
    // Every account held here answers, not just the open one: a request to an
    // install that never reads it would turn a live holder into a forced take.
    held: accounts.filter(isHeldHere).map((a) => a.index),
    /** The other installs this one knows of: the far ends of its links. */
    peers: accounts.flatMap((a) => {
      const holding = holdingOf(a)
      return holding.kind === 'elsewhere' && holding.deviceId ? [holding.deviceId] : []
    }),
    channel: await defaultChannel(),
    link: defaultLink,
  }
}

async function serveTick(): Promise<void> {
  if (serving) return
  serving = true
  try {
    await inSerial(async () => {
      noteHoldingServed()
      const ctx = await serveContext()
      if (!ctx) return
      await serveVaultLink(ctx.peers)
      const order = [ctx.activeIndex, ...ctx.held.filter((i) => i !== ctx.activeIndex)]
      for (const index of order) {
        if (!runtimeIsCurrent(ctx.runtime)) break
        if (!ctx.held.includes(index)) continue
        await serveHoldingChannel(ctx.targetFor(index), ctx.channel, Date.now(), ctx.link)
      }
      const { flushPendingHandovers } = await import('./accountHandover')
      await flushPendingHandovers(ctx.master)
    })
  } catch (error) {
    appendAppLog('warn', `[account-holding] serve failed: ${messageOf(error)}`)
  } finally {
    serving = false
  }
}

function onDirectBody(body: string, fromDevice: string): void {
  let probe: { type?: unknown; identityKey?: unknown }
  try {
    probe = JSON.parse(body) as typeof probe
  } catch {
    return
  }
  if (probe?.type !== 'release-request' || typeof probe.identityKey !== 'string') return
  const identityKey = probe.identityKey
  void inSerial(async () => {
    const ctx = await serveContext()
    if (!ctx) return
    const index = ctx.held.find((i) => identityKeyForAccount(ctx.master, i) === identityKey)
    if (index == null) return
    await answerDirectRequest(ctx.targetFor(index), body, fromDevice, ctx.channel, ctx.link)
  }).catch((error: unknown) => appendAppLog('warn', `[account-holding] direct request failed: ${messageOf(error)}`))
}

/** Serve the holding channels of every account held here, and the vault link, until the vault locks. */
export function startHoldingService(): void {
  if (typeof window === 'undefined' || import.meta.env?.MODE === 'test') return
  if (!serveTimer) serveTimer = setInterval(() => void serveTick(), HOLDING_SERVE_MS)
  if (!gapListener) {
    gapListener = () => noteHoldingGap()
    window.addEventListener('online', gapListener)
  }
  directListener ??= onVaultLinkMessage(onDirectBody)
  void serveTick()
}

export function stopHoldingService(): void {
  if (serveTimer) clearInterval(serveTimer)
  serveTimer = null
  if (gapListener && typeof window !== 'undefined') window.removeEventListener('online', gapListener)
  gapListener = null
  directListener?.()
  directListener = null
  stopVaultLink()
  noteHoldingGap()
}

/**
 * Before a spend: check the active account once if a gap left its holding
 * unconfirmed. A host that cannot answer leaves local holding as it was.
 */
export async function ensureHoldingFresh(
  active: { identityKey: string; accountIndex: number; vaultMaster?: VaultMaster | null } | null,
): Promise<void> {
  if (!serveTimer || !active?.vaultMaster) return
  if (isHoldingFresh(active.identityKey)) return
  const started = Date.now()
  await checkVaultAccountHoldings(active.vaultMaster, { indices: [active.accountIndex] })
  appendAppLog('info', `[account-holding] gap check a${active.accountIndex} done ${Date.now() - started}ms`)
}
