import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise } from 'xstate'
import type { NewDeviceSignin, SigninStep } from '../wallet/deviceSignin'
import type { VaultTransfer } from '../wallet/deviceTransfer'
import { RELAY_SIGNIN_POLL_MS, relaySigninMachine } from './relaySigninMachine'

const signin = { start: { binding: 'b'.repeat(32), online: 1, devices: [] } } as unknown as NewDeviceSignin
const transfer = {
  v: 1,
  kind: 'handcash-brc250-vault',
  master: { derivation: 'brc-42', keyHex: PrivateKey.fromRandom().toHex() },
  enrollment: null,
  accounts: {},
  sentAt: 1,
} as VaultTransfer

function run(steps: Array<SigninStep | Error | Promise<SigninStep>>) {
  let calls = 0
  let inFlight = 0
  let overlap = false
  const machine = relaySigninMachine.provide({
    actors: {
      advance: fromPromise(async () => {
        inFlight += 1
        if (inFlight > 1) overlap = true
        try {
          const next = steps[Math.min(calls++, steps.length - 1)]!
          if (next instanceof Error) throw next
          return await next
        } finally {
          inFlight -= 1
        }
      }),
    },
  })
  const actor = createActor(machine, { input: { signin } }).start()
  return { actor, calls: () => calls, overlapped: () => overlap }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('relay sign-in chart', () => {
  it('never starts a read while the last one is still out', async () => {
    let release!: (step: SigninStep) => void
    const slow = new Promise<SigninStep>((resolve) => (release = resolve))
    const h = run([slow, { state: 'waiting', expiresAt: 1 }])
    await vi.advanceTimersByTimeAsync(RELAY_SIGNIN_POLL_MS * 5)
    expect(h.calls()).toBe(1)
    release({ state: 'waiting', expiresAt: 1 })
    await flush()
    await vi.advanceTimersByTimeAsync(RELAY_SIGNIN_POLL_MS)
    expect(h.calls()).toBe(2)
    expect(h.overlapped()).toBe(false)
  })

  it('shows the comparison code and keeps polling', async () => {
    const h = run([{ state: 'comparing', code: '12345678', expiresAt: 1 }])
    await flush()
    expect(h.actor.getSnapshot().value).toBe('resting')
    expect(h.actor.getSnapshot().context.code).toBe('12345678')
  })

  it('says when the network dropped and clears it once the relay answers again', async () => {
    const h = run([new TypeError('Failed to fetch'), { state: 'waiting', expiresAt: 1 }])
    await flush()
    expect(h.actor.getSnapshot().context.error).toMatch(/No connection/)
    await vi.advanceTimersByTimeAsync(RELAY_SIGNIN_POLL_MS)
    expect(h.actor.getSnapshot().context.error).toBeNull()
    expect(h.actor.getSnapshot().value).toBe('resting')
  })

  it('stops at approval with the vault, and reads no more', async () => {
    const h = run([{ state: 'approved', transfer, approverLabel: 'Mac' }])
    await flush()
    const snapshot = h.actor.getSnapshot()
    expect(snapshot.status).toBe('done')
    expect(snapshot.value).toBe('approved')
    expect(snapshot.context.transfer).toBe(transfer)
    expect(snapshot.context.approverLabel).toBe('Mac')
    await vi.advanceTimersByTimeAsync(RELAY_SIGNIN_POLL_MS * 3)
    expect(h.calls()).toBe(1)
  })

  it('ends on refusal or expiry', async () => {
    const refused = run([{ state: 'refused' }])
    const expired = run([{ state: 'expired' }])
    await flush()
    expect(refused.actor.getSnapshot().value).toBe('refused')
    expect(expired.actor.getSnapshot().value).toBe('expired')
  })
})
