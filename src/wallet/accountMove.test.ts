import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import {
  parseHolderRecord,
  signHolderRecord,
  type AccountKeys,
  type HolderRead,
  type HolderRecord,
  type HolderWrite,
} from './accountHolding'
import {
  answerDirectRequest,
  moveAccountHere,
  serveHoldingChannel,
  type DirectLink,
  type HoldingChannel,
  type ServeTarget,
} from './accountMove'
import {
  ANSWER_WINDOW_MS,
  REQUEST_MAX_AGE_MS,
  RELEASE_WINDOW_MS,
  parseHoldingMessage,
  signReleaseAccept,
  signReleaseRequest,
} from './accountRelease'
import type { ListedMessage } from './messageTransport'
import type { HolderIo } from './vaultAccountHolding'
import {
  createVaultAccount,
  holdingOf,
  identityKeyForAccount,
  initCreatedVaultAccounts,
  readVaultAccounts,
  rootKeyHexForAccount,
} from './vaultAccounts'
import { brc157VaultMaster } from './vaultMaster'

const MASTER = brc157VaultMaster(Array(32).fill(0x3c))
const MASTER_IK = identityKeyForAccount(MASTER, 0)
const INDEX = 1
const KEYS: AccountKeys = { identityKey: identityKeyForAccount(MASTER, INDEX), rootKeyHex: rootKeyHexForAccount(MASTER, INDEX) }

function host() {
  let row: { body: string; etag: string } | null = null
  let n = 0
  const state = { up: true }
  const put = (fields: { deviceId: string; state: 'held' | 'released'; seq: number }) => {
    const record = signHolderRecord(KEYS.rootKeyHex, fields)
    row = { body: JSON.stringify(record), etag: `"${++n}"` }
    return record
  }
  const io = (deviceId: string): HolderIo => ({
    deviceId: () => deviceId,
    read: async (): Promise<HolderRead> => {
      if (!state.up) return { kind: 'unreachable', reason: 'offline' }
      if (!row) return { kind: 'absent' }
      const record = parseHolderRecord(JSON.parse(row.body), KEYS.identityKey)
      return record ? { kind: 'record', record, etag: row.etag } : { kind: 'unreachable', reason: 'bad' }
    },
    write: async (_account, fields, condition): Promise<HolderWrite> => {
      if (!state.up) return { kind: 'unreachable', reason: 'offline' }
      if (condition.create && row) return { kind: 'conflict' }
      if (!condition.create && condition.etag && condition.etag !== row?.etag) return { kind: 'conflict' }
      return { kind: 'written', record: put(fields) }
    },
  })
  const record = () => (row ? (JSON.parse(row.body) as HolderRecord) : null)
  return { io, put, record, state }
}

function box(onSend?: (body: string) => void) {
  const messages: ListedMessage[] = []
  let n = 0
  const state = { up: true, sendFails: false }
  const acked: string[] = []
  const channel: HoldingChannel = {
    list: async () => (state.up ? messages.map((m) => ({ ...m })) : null),
    send: async (_root, body) => {
      if (state.sendFails) throw new Error('box refused')
      messages.push({ messageId: `m${++n}`, body, createdAt: Date.now() })
      onSend?.(body)
    },
    acknowledge: async (_root, ids) => {
      acked.push(...ids)
      for (const id of ids) {
        const i = messages.findIndex((m) => m.messageId === id)
        if (i >= 0) messages.splice(i, 1)
      }
    },
  }
  const post = (body: unknown) => messages.push({ messageId: `m${++n}`, body: JSON.stringify(body), createdAt: Date.now() })
  return { channel, messages, acked, state, post }
}

const devices = new Map<string, Map<string, string>>()
function on(device: string) {
  if (!devices.has(device)) devices.set(device, new Map())
  const mem = devices.get(device)!
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  })
}

const localHolding = () => holdingOf(readVaultAccounts(MASTER_IK).accounts.find((a) => a.index === INDEX)!)

/** Install B lists account 1 as held by A, who announced it at seq 1. */
function moverListsHeldAccount(h: ReturnType<typeof host>) {
  on('B')
  initCreatedVaultAccounts(MASTER)
  createVaultAccount({ master: MASTER, name: 'Wallet 1', index: INDEX, holding: { kind: 'elsewhere', seq: 1, deviceId: 'A' } })
  h.put({ deviceId: 'A', state: 'held', seq: 1 })
}

beforeEach(() => {
  devices.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('moving an account here (BRC-249, no prompt)', () => {
  it('a released account is taken at once, without asking anyone', async () => {
    const h = host()
    const b = box()
    moverListsHeldAccount(h)
    h.put({ deviceId: 'A', state: 'released', seq: 2 })
    const result = await moveAccountHere({ master: MASTER, index: INDEX, io: h.io('B'), channel: b.channel })
    expect(result).toEqual({ kind: 'moved', forced: false })
    expect(h.record()).toMatchObject({ deviceId: 'B', state: 'held', seq: 3 })
    expect(localHolding()).toEqual({ kind: 'here', seq: 3 })
    expect(b.messages).toHaveLength(0)
  })

  it('a live holder accepts and releases; the mover takes on the release', async () => {
    const h = host()
    const phases: string[] = []
    const b = box((body) => {
      const msg = parseHoldingMessage(body, KEYS.identityKey)
      if (msg?.type !== 'release-request') return
      expect(msg).toMatchObject({ deviceId: 'B', seq: 1 })
      setTimeout(() => b.post(signReleaseAccept(KEYS.rootKeyHex, { deviceId: 'A', nonce: msg.nonce })), 1_500)
      setTimeout(() => h.put({ deviceId: 'A', state: 'released', seq: 2 }), 4_000)
    })
    moverListsHeldAccount(h)
    const moving = moveAccountHere({
      master: MASTER,
      index: INDEX,
      io: h.io('B'),
      channel: b.channel,
      onPhase: (p) => phases.push(p),
    })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await moving).toEqual({ kind: 'moved', forced: false })
    expect(phases).toEqual(expect.arrayContaining(['reading', 'dialing', 'requestingBox', 'awaitingAccept', 'awaitingRelease', 'taking']))
    expect(phases).not.toContain('forcing')
    expect(h.record()).toMatchObject({ deviceId: 'B', state: 'held', seq: 3 })
    // Its own request and the accept carrying its nonce are both consumed.
    expect(b.messages).toHaveLength(0)
  })

  it('a holder that does not answer within the answer window is offline: the take is forced', async () => {
    const h = host()
    const b = box()
    moverListsHeldAccount(h)
    const moving = moveAccountHere({ master: MASTER, index: INDEX, io: h.io('B'), channel: b.channel })
    await vi.advanceTimersByTimeAsync(ANSWER_WINDOW_MS - 1_000)
    expect(h.record()).toMatchObject({ deviceId: 'A', seq: 1 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await moving).toEqual({ kind: 'moved', forced: true })
    expect(h.record()).toMatchObject({ deviceId: 'B', state: 'held', seq: 2 })
    expect(localHolding()).toEqual({ kind: 'here', seq: 2 })
    expect(b.messages).toHaveLength(0)
  })

  it('a holder that accepts but never releases is forced after the release window', async () => {
    const h = host()
    const b = box((body) => {
      const msg = parseHoldingMessage(body, KEYS.identityKey)
      if (msg?.type === 'release-request') b.post(signReleaseAccept(KEYS.rootKeyHex, { deviceId: 'A', nonce: msg.nonce }))
    })
    moverListsHeldAccount(h)
    const moving = moveAccountHere({ master: MASTER, index: INDEX, io: h.io('B'), channel: b.channel })
    await vi.advanceTimersByTimeAsync(ANSWER_WINDOW_MS + 5_000)
    expect(h.record()).toMatchObject({ deviceId: 'A', seq: 1 })
    await vi.advanceTimersByTimeAsync(RELEASE_WINDOW_MS)
    expect(await moving).toEqual({ kind: 'moved', forced: true })
    expect(h.record()).toMatchObject({ deviceId: 'B', seq: 2 })
  })

  it('never forces without having asked: a box that refuses the request fails the move', async () => {
    const h = host()
    const b = box()
    b.state.sendFails = true
    moverListsHeldAccount(h)
    const moving = moveAccountHere({ master: MASTER, index: INDEX, io: h.io('B'), channel: b.channel })
    await vi.advanceTimersByTimeAsync(ANSWER_WINDOW_MS * 2)
    const result = await moving
    expect(result).toMatchObject({ kind: 'failed', failure: 'channel-unreachable' })
    expect(h.record()).toMatchObject({ deviceId: 'A', seq: 1 })
    expect(localHolding()).toMatchObject({ kind: 'elsewhere', deviceId: 'A' })
  })

  it('an unreachable backup host fails the move and changes nothing', async () => {
    const h = host()
    const b = box()
    moverListsHeldAccount(h)
    h.state.up = false
    const result = await moveAccountHere({ master: MASTER, index: INDEX, io: h.io('B'), channel: b.channel })
    expect(result).toMatchObject({ kind: 'failed', failure: 'host-unreachable' })
    expect(b.messages).toHaveLength(0)
    expect(localHolding()).toMatchObject({ kind: 'elsewhere' })
  })
})

/** One end of a link: what this install sent, and a way to hand it frames from the far end. */
function linkEnd(opts: { open?: boolean; acks?: boolean; onSend?: (device: string, body: string) => void } = {}) {
  const listeners = new Set<(body: string, device: string) => void>()
  const sent: Array<{ device: string; body: string }> = []
  const link: DirectLink = {
    dial: async () => opts.open ?? true,
    send: async (device, body) => {
      if (!(opts.acks ?? true)) return 'box'
      sent.push({ device, body })
      opts.onSend?.(device, body)
      return 'direct'
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const deliver = (body: string, device: string) => listeners.forEach((l) => l(body, device))
  return { link, sent, deliver }
}

describe('moving device to device over the vault link', () => {
  it('asks the holding device directly and takes on its release, with nothing in the box', async () => {
    const h = host()
    const b = box()
    const phases: string[] = []
    const mover = linkEnd({
      onSend: (device, body) => {
        expect(device).toBe('A')
        const msg = parseHoldingMessage(body, KEYS.identityKey)
        if (msg?.type !== 'release-request') return
        setTimeout(() => mover.deliver(JSON.stringify(signReleaseAccept(KEYS.rootKeyHex, { deviceId: 'A', nonce: msg.nonce })), 'A'), 50)
        setTimeout(() => h.put({ deviceId: 'A', state: 'released', seq: 2 }), 300)
      },
    })
    moverListsHeldAccount(h)
    const moving = moveAccountHere({
      master: MASTER,
      index: INDEX,
      io: h.io('B'),
      channel: b.channel,
      link: mover.link,
      onPhase: (p) => phases.push(p),
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await moving).toEqual({ kind: 'moved', forced: false })
    expect(phases).toEqual(expect.arrayContaining(['dialing', 'requestingDirect', 'awaitingAccept', 'awaitingRelease']))
    expect(phases).not.toContain('requestingBox')
    expect(mover.sent).toHaveLength(1)
    expect(b.messages).toHaveLength(0)
    expect(h.record()).toMatchObject({ deviceId: 'B', state: 'held', seq: 3 })
  })

  it('uses the box only when the link does not ack the request', async () => {
    const h = host()
    const b = box()
    const phases: string[] = []
    const mover = linkEnd({ acks: false })
    moverListsHeldAccount(h)
    const moving = moveAccountHere({
      master: MASTER,
      index: INDEX,
      io: h.io('B'),
      channel: b.channel,
      link: mover.link,
      onPhase: (p) => phases.push(p),
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(phases).toEqual(expect.arrayContaining(['dialing', 'requestingDirect', 'requestingBox']))
    expect(b.messages.map((m) => parseHoldingMessage(m.body, KEYS.identityKey)?.type)).toEqual(['release-request'])
    await vi.advanceTimersByTimeAsync(ANSWER_WINDOW_MS + 1_000)
    expect(await moving).toEqual({ kind: 'moved', forced: true })
  })
})

describe('the holder answering over the vault link', () => {
  function heldHere(seq: number) {
    on('A')
    initCreatedVaultAccounts(MASTER)
    createVaultAccount({ master: MASTER, name: 'Wallet 1', index: INDEX, holding: { kind: 'here', seq } })
    const calls = { release: 0 }
    const target: ServeTarget = {
      master: MASTER,
      index: INDEX,
      identityKey: KEYS.identityKey,
      rootKeyHex: KEYS.rootKeyHex,
      deviceId: 'A',
      release: async () => void (calls.release += 1),
      merge: null,
      recheck: () => {},
      open: () => null,
    }
    return { target, calls }
  }

  it('accepts at once and answers on the link, never the box', async () => {
    const { target, calls } = heldHere(5)
    const b = box()
    const holder = linkEnd()
    const request = signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 5 })
    const outcome = await answerDirectRequest(target, JSON.stringify(request), 'B', b.channel, holder.link)
    expect(outcome).toEqual({ kind: 'released', to: 'B' })
    expect(calls.release).toBe(1)
    expect(holder.sent).toHaveLength(1)
    expect(holder.sent[0]!.device).toBe('B')
    expect(parseHoldingMessage(holder.sent[0]!.body, KEYS.identityKey)).toMatchObject({ type: 'release-accept', nonce: request.nonce })
    expect(b.messages).toHaveLength(0)
  })

  it('refuses a request whose signed device is not the device on the link', async () => {
    const { target, calls } = heldHere(5)
    const b = box()
    const holder = linkEnd()
    const request = signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 5 })
    expect(await answerDirectRequest(target, JSON.stringify(request), 'C', b.channel, holder.link)).toEqual({ kind: 'idle' })
    expect(calls.release).toBe(0)
    expect(holder.sent).toHaveLength(0)
  })

  it('answers through the box when its reply on the link is not acked', async () => {
    const { target } = heldHere(5)
    const b = box()
    const holder = linkEnd({ acks: false })
    const request = signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 5 })
    expect(await answerDirectRequest(target, JSON.stringify(request), 'B', b.channel, holder.link)).toEqual({ kind: 'released', to: 'B' })
    expect(parseHoldingMessage(b.messages[0]!.body, KEYS.identityKey)).toMatchObject({ type: 'release-accept', nonce: request.nonce })
  })
})

describe('the holder serving its holding channel', () => {
  function holder(seq: number) {
    on('A')
    initCreatedVaultAccounts(MASTER)
    createVaultAccount({ master: MASTER, name: 'Wallet 1', index: INDEX, holding: { kind: 'here', seq } })
    const calls = { release: 0, recheck: 0, merged: [] as string[] }
    const target: ServeTarget = {
      master: MASTER,
      index: INDEX,
      identityKey: KEYS.identityKey,
      rootKeyHex: KEYS.rootKeyHex,
      deviceId: 'A',
      release: async () => {
        calls.release += 1
      },
      merge: async (json) => void calls.merged.push(json),
      recheck: () => void (calls.recheck += 1),
      open: () => null,
    }
    return { target, calls }
  }

  it('accepts a valid request at once, answers with its nonce, consumes it, then releases', async () => {
    const { target, calls } = holder(4)
    const b = box()
    const request = signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 4 })
    b.post(request)
    const outcome = await serveHoldingChannel(target, b.channel)
    expect(outcome).toEqual({ kind: 'released', to: 'B' })
    expect(calls.release).toBe(1)
    expect(b.messages).toHaveLength(1)
    const accept = parseHoldingMessage(b.messages[0]!.body, KEYS.identityKey)
    expect(accept).toMatchObject({ type: 'release-accept', deviceId: 'A', nonce: request.nonce })
  })

  it('drops overtaken requests and its own expired ones; leaves a newer seq and re-checks', async () => {
    const { target, calls } = holder(4)
    const b = box()
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 3 }))
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'A', seq: 4, at: Date.now() - REQUEST_MAX_AGE_MS - 1 }))
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'C', seq: 9 }))
    const outcome = await serveHoldingChannel(target, b.channel)
    expect(outcome).toEqual({ kind: 'idle' })
    expect(calls.release).toBe(0)
    expect(calls.recheck).toBe(1)
    expect(b.messages.map((m) => parseHoldingMessage(m.body, KEYS.identityKey)?.deviceId)).toEqual(['C'])
  })

  it('an install that does not hold the account consumes nothing', async () => {
    const { target } = holder(4)
    devices.clear()
    on('A')
    initCreatedVaultAccounts(MASTER)
    createVaultAccount({ master: MASTER, name: 'Wallet 1', index: INDEX, holding: { kind: 'elsewhere', seq: 4, deviceId: 'B' } })
    const b = box()
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'C', seq: 4 }))
    expect(await serveHoldingChannel(target, b.channel)).toEqual({ kind: 'not-holder' })
    expect(b.messages).toHaveLength(1)
  })

  it('an account that is not open still answers, and leaves its handovers for when it opens', async () => {
    const { target, calls } = holder(3)
    target.merge = null
    target.open = (body) => body
    const b = box()
    const handover = { v: 1, type: 'handover', identityKey: KEYS.identityKey, deviceId: 'C', handoverId: 'x', part: 0, parts: 1, data: '{}' }
    b.post(handover)
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 3 }))
    expect(await serveHoldingChannel(target, b.channel)).toEqual({ kind: 'released', to: 'B' })
    expect(calls.release).toBe(1)
    const left = b.messages.map((m) => JSON.parse(m.body) as { type: string })
    expect(left.map((m) => m.type).sort()).toEqual(['handover', 'release-accept'])
  })

  it('keeps the account when the release after an accept fails (the mover forces later)', async () => {
    const { target } = holder(2)
    target.release = async () => {
      throw new Error('history upload failed')
    }
    const b = box()
    b.post(signReleaseRequest(KEYS.rootKeyHex, { deviceId: 'B', seq: 2 }))
    expect(await serveHoldingChannel(target, b.channel)).toEqual({
      kind: 'release-failed',
      reason: 'history upload failed',
    })
    expect(localHolding()).toEqual({ kind: 'here', seq: 2 })
  })
})
