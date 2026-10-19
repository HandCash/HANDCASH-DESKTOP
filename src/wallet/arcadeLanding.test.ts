import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletRuntime } from './walletRuntime'
import type { ArcadeTxFate } from './arcadeV2'

const DEAD = '09c17bab2cd75dda6e31917c9165b91da62e0af2a5f153b0e00b14a6e22098d4'
const CHILD = '10286bbb1a57974ddb8898620bf062272f90decab344ae5969b599edc5865857'
const LIVE = 'a1'.repeat(32)
const SLOW = 'c1'.repeat(32)
const DEAD_INPUT = `${'d4'.repeat(32)}.7`
const SPENDER = '59a99dc737b29920c847f583ec1022023dad7583790dbdabe253c5c0868f85d5'
const HOUR = 60 * 60_000

const prefs = new Map<string, string>()
const calls: string[] = []
const rejected = new Set<string>()
let pins: Array<{ txid: string; at: number }> = []
let fates: Record<string, ArcadeTxFate> = {}
let inputsOf: Record<string, string[]> = {}
let spentBy: Record<string, string> = {}

const runtime = {
  instance: { chain: 'main', identityKey: '02ab', services: {} },
  runtimeId: 'r1',
} as unknown as WalletRuntime

const toastError = vi.fn()
const reportLateMinerSubmitFailure = vi.fn(async (_args: unknown) => {})
const scheduleDeadCoinSweep = vi.fn()

vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => runtime,
  runtimeIsCurrent: () => true,
}))
vi.mock('./accountLocalKeys', () => ({ accountKeyScopeFor: () => undefined }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => prefs.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    prefs.set(key, value)
    return true
  },
}))
vi.mock('./arcadeV2', () => ({
  fetchArcadeTxFate: async (_chain: string, txid: string) => fates[txid] ?? { kind: 'unknown' },
  arcadeStatusLanded: (s: string) => s === 'SEEN_ON_NETWORK' || s === 'MINED',
}))
vi.mock('./arcadeSubmitGuard', () => ({
  listArcadeSubmitContacts: () => pins,
  txIsArcadeRejected: (txid: string) => rejected.has(txid),
  noteArcadeRejectedTx: (txid: string) => {
    calls.push(`reject:${txid.slice(0, 4)}`)
    rejected.add(txid)
  },
}))
vi.mock('./legacyScan', () => ({ txExistsOnChain: async () => false }))
vi.mock('./signedTxInputs', () => ({
  inputOutpointsForSignedTx: async (txid: string) => inputsOf[txid] ?? [],
}))
vi.mock('./createActionInputFate', () => ({
  probeOutpointSpends: async (outpoints: string[]) =>
    new Map(
      outpoints.map((op) => [
        op,
        spentBy[op]
          ? { kind: 'spent', spender: spentBy[op] }
          : { kind: 'unknown' },
      ]),
    ),
}))
vi.mock('./walletCoordinator', () => ({ shouldYieldChainIngestToSpend: () => false }))
vi.mock('./pendingMinerOutbox', () => ({ removePendingMinerSubmit: vi.fn() }))
vi.mock('./ghostTxSuppress', () => ({ rememberGhostTx: vi.fn() }))
vi.mock('./staleOutputRelease', () => ({
  failUnsentLocalTx: async (txid: string) => {
    calls.push(`fail:${txid.slice(0, 4)}`)
    return true
  },
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    calls.push(`hide:${outpoints.join(',')}@${spender.slice(0, 4)}`)
    return outpoints.length
  },
}))
vi.mock('./deadCoinSweep', () => ({
  scheduleDeadCoinSweep: (...a: unknown[]) => scheduleDeadCoinSweep(...a),
}))
vi.mock('./session', () => ({ bumpBalanceAfterHeal: vi.fn() }))
vi.mock('./minerSubmit', () => ({
  reportLateMinerSubmitFailure: (args: unknown) => reportLateMinerSubmitFailure(args),
}))
vi.mock('./recompose', () => ({ isRecomposeInFlight: () => false }))
vi.mock('./toast', () => ({ toastError: (...a: unknown[]) => toastError(...a) }))
let bodies: Record<string, number[]> = {}
vi.mock('./signedChequeArchive', () => ({ signedChequeAtomic: (txid: string) => bodies[txid] ?? null }))

const stalled: ArcadeTxFate = {
  kind: 'stalled',
  status: 'PENDING_RETRY',
  reason: 'failed to validate transaction',
}

describe('arcadeLanding', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    prefs.clear()
    calls.length = 0
    rejected.clear()
    toastError.mockClear()
    reportLateMinerSubmitFailure.mockClear()
    scheduleDeadCoinSweep.mockClear()
    const now = Date.now()
    pins = [
      { txid: DEAD, at: now - 10 * HOUR },
      { txid: CHILD, at: now - 9 * HOUR },
      { txid: LIVE, at: now - 8 * HOUR },
      { txid: SLOW, at: now - 7 * HOUR },
    ]
    fates = {
      [DEAD]: stalled,
      [CHILD]: stalled,
      [LIVE]: { kind: 'accepted', status: 'SEEN_ON_NETWORK' },
      [SLOW]: stalled,
    }
    inputsOf = {
      [DEAD]: [DEAD_INPUT],
      [CHILD]: [`${DEAD}.1`],
      [SLOW]: [`${'e5'.repeat(32)}.0`],
    }
    spentBy = { [DEAD_INPUT]: SPENDER }
    bodies = {}
    ;(runtime.instance as unknown as { services: unknown }).services = {}
    const { resetArcadeLandingForTests } = await import('./arcadeLanding')
    resetArcadeLandingForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('unlock fails dead cheques parent-first, hides dead coins after the fail, and toasts once', async () => {
    const { scheduleUnlockLandingPass, txLanded } = await import('./arcadeLanding')
    scheduleUnlockLandingPass(runtime)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(calls).toEqual([
      `reject:${DEAD.slice(0, 4)}`,
      `fail:${DEAD.slice(0, 4)}`,
      `hide:${DEAD_INPUT}@${SPENDER.slice(0, 4)}`,
      `reject:${CHILD.slice(0, 4)}`,
      `fail:${CHILD.slice(0, 4)}`,
    ])
    expect(txLanded(LIVE)).toBe(true)
    expect(rejected.has(SLOW)).toBe(false)
    expect(scheduleDeadCoinSweep).toHaveBeenCalledTimes(1)
    expect(reportLateMinerSubmitFailure).toHaveBeenCalledTimes(2)
    expect(reportLateMinerSubmitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ txid: DEAD, toast: false }),
    )
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith(
      '2 payments did not reach the chain',
      expect.any(String),
    )
  })

  it('a live watch stops at the first node-held status', async () => {
    const { watchArcadeLanding, txLanded } = await import('./arcadeLanding')
    fates[SLOW] = { kind: 'accepted', status: 'RECEIVED' }
    watchArcadeLanding(SLOW)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(txLanded(SLOW)).toBe(false)
    fates[SLOW] = { kind: 'accepted', status: 'SEEN_ON_NETWORK' }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(txLanded(SLOW)).toBe(true)
    expect(calls).toEqual([])
  })

  it('unlock re-posts a stalled cheque with the parents the network never saw, Arcade first, each parent once', async () => {
    const { Beef, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } = await import('@bsv/sdk')
    const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    const spend = (parent: InstanceType<typeof Transaction>, vout: number) => {
      const t = new Transaction()
      t.addInput({ sourceTXID: parent.id('hex'), sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      t.addOutput({ lockingScript: lock, satoshis: 1 })
      return t
    }
    const mined = new Transaction()
    mined.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    mined.addOutput({ lockingScript: lock, satoshis: 2 })
    mined.addOutput({ lockingScript: lock, satoshis: 2 })
    const parent = new Transaction()
    parent.addInput({ sourceTXID: mined.id('hex'), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    parent.addOutput({ lockingScript: lock, satoshis: 1 })
    parent.addOutput({ lockingScript: lock, satoshis: 1 })
    const first = spend(parent, 0)
    const second = spend(parent, 1)
    const body = (t: InstanceType<typeof Transaction>) => {
      const beef = new Beef()
      beef.mergeRawTx(mined.toBinary(), beef.mergeBump(new MerklePath(9, [[{ offset: 0, hash: mined.id('hex'), txid: true }]])))
      beef.mergeRawTx(parent.toBinary())
      beef.mergeRawTx(t.toBinary())
      return beef.toBinary()
    }
    const [p, a, b] = [parent, first, second].map((t) => t.id('hex'))
    const posts: string[] = []
    const service = (name: string) => ({
      name,
      service: async (_beef: unknown, txids: string[]) => {
        posts.push(`${name}:${txids.map((id) => id.slice(0, 4)).join(',')}`)
        return { status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }
      },
    })
    ;(runtime.instance as unknown as { services: unknown }).services = {
      postBeefServices: { services: [service('arcade'), service('WoC')] },
    }
    const now = Date.now()
    pins = [
      { txid: a!, at: now - 3 * HOUR },
      { txid: b!, at: now - 2 * HOUR },
    ]
    fates = { [a!]: stalled, [b!]: stalled }
    inputsOf = { [a!]: [`${p}.0`], [b!]: [`${p}.1`] }
    bodies = { [a!]: body(first), [b!]: body(second) }
    // Loaded ahead: a first dynamic import takes real time the fake clock does not advance.
    await Promise.all([import('./beefSubset'), import('./postBeefResult')])

    const { scheduleUnlockLandingPass } = await import('./arcadeLanding')
    scheduleUnlockLandingPass(runtime)
    await vi.advanceTimersByTimeAsync(30_000)

    const short = (id: string) => id.slice(0, 4)
    expect(posts).toEqual([
      `arcade:${short(p!)},${short(a!)}`,
      `WoC:${short(p!)},${short(a!)}`,
      `WoC:${short(b!)}`,
    ])
    expect(calls).toEqual([])
  })

  it('a live watch retires a stalled cheque the chain proves dead', async () => {
    const { watchArcadeLanding } = await import('./arcadeLanding')
    watchArcadeLanding(DEAD, { atomic: [1, 2, 3] })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toEqual([
      `reject:${DEAD.slice(0, 4)}`,
      `fail:${DEAD.slice(0, 4)}`,
      `hide:${DEAD_INPUT}@${SPENDER.slice(0, 4)}`,
    ])
    expect(reportLateMinerSubmitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ txid: DEAD, toast: true }),
    )
  })
})
