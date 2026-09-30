import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Wallet } from '@bsv/wallet-toolbox-client'
import {
  InputsUnverifiedError,
  installSpendCertainty,
  resetSignablesForTests,
  signWithCertainInputs,
} from './inputCertainty'
import {
  coinCleared,
  noteCoinsCleared,
  noteTxCertified,
  resetSpendCertaintyForTests,
  txCertified,
} from './spendCertainty'

const calls: string[] = []
const arcade = new Map<string, { kind: string; status?: string; reason?: string }>()
const rejected = new Set<string>()
const peerSpent = new Map<string, string>()
let peerRead: () => Promise<unknown> = async () => ({ kind: 'throttled' })

vi.mock('./peerDeviceSpends', () => ({
  peerSpenderOf: (outpoint: string) => peerSpent.get(outpoint) ?? null,
  refreshPeerDeviceSpends: () => peerRead(),
}))

vi.mock('./staleOutputRelease', () => ({
  failUnsentLocalTx: async (txid: string, opts?: { noDescendants?: boolean }) => {
    calls.push(`fail ${txid.slice(0, 4)}${opts?.noDescendants ? ' fresh' : ''}`)
    return true
  },
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    calls.push(`hide ${outpoints.length} by ${spender.slice(0, 4)}`)
    return outpoints.length
  },
}))
vi.mock('./deadCoinSweep', () => ({ scheduleDeadCoinSweep: () => undefined }))
vi.mock('./session', () => ({
  getActiveWallet: () => null,
  bumpBalanceAfterHeal: () => undefined,
}))
vi.mock('./arcadeSubmitGuard', () => ({
  txIsArcadeRejected: (txid: string) => rejected.has(txid),
  noteArcadeRejectedTx: (txid: string) => rejected.add(txid),
}))
vi.mock('./arcadeLanding', () => ({
  txLanded: () => false,
  noteTxLanded: () => undefined,
}))
vi.mock('./arcadeV2', () => ({
  fetchArcadeTxFate: async (_chain: string, txid: string) => {
    calls.push(`arcade ${txid.slice(0, 4)}`)
    return arcade.get(txid) ?? { kind: 'unknown' }
  },
  arcadeStatusLanded: (status: string) => status === 'ACCEPTED_BY_NETWORK',
}))
vi.mock('./legacyScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./legacyScan')>()),
  txExistsOnChain: async () => false,
}))

const SPENDER = 'dd'.repeat(32)
const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function tx(prev: string, sats: number): Transaction {
  const t = new Transaction()
  t.addInput({ sourceTXID: prev, sourceOutputIndex: 0, unlockingScript: new Script() })
  t.addOutput({ lockingScript: lock, satoshis: sats })
  return t
}

let seq = 0
/** A signed createAction result spending output 0 of a parent. */
function signedOver(opts: { parentMined: boolean }) {
  seq += 1
  const parent = tx(`${seq.toString(16).padStart(2, '0')}`.repeat(32), 10_000)
  if (opts.parentMined) {
    parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 900_000)
  }
  const child = tx(parent.id('hex'), 9_000)
  const beef = new Beef()
  if (opts.parentMined) beef.mergeTransaction(parent)
  else beef.mergeRawTx(parent.toBinary())
  beef.mergeRawTx(child.toBinary())
  const txid = child.id('hex')
  return {
    result: { txid, tx: Array.from(beef.toBinaryAtomic(txid)) },
    parent: parent.id('hex'),
    input: `${parent.id('hex')}.0`,
  }
}

type Utxo = { txid: string; vout: number }
function wocAnswers(answer: (utxo: Utxo) => Record<string, unknown> | 'omit') {
  const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
    const { utxos } = JSON.parse(init?.body ?? '{"utxos":[]}') as { utxos: Utxo[] }
    return {
      ok: true,
      status: 200,
      json: async () =>
        utxos.flatMap((utxo) => {
          const a = answer(utxo)
          return a === 'omit' ? [] : [{ utxo, error: '', ...a }]
        }),
    }
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('signWithCertainInputs', () => {
  beforeEach(() => {
    calls.length = 0
    arcade.clear()
    rejected.clear()
    peerSpent.clear()
    peerRead = async () => ({ kind: 'throttled' })
    resetSpendCertaintyForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns once the explorer clears every coin, and certifies the send', async () => {
    const { result, input } = signedOver({ parentMined: true })
    wocAnswers(() => ({}))
    await expect(signWithCertainInputs(async () => result, 'main')).resolves.toBe(result)
    expect(txCertified(result.txid)).toBe(true)
    expect(coinCleared(input)).toBe(false)
  })

  it('answers a cleared coin from memory', async () => {
    const { result, input } = signedOver({ parentMined: true })
    noteCoinsCleared([input])
    const fetch = wocAnswers(() => ({}))
    await signWithCertainInputs(async () => result, 'main')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retires a coin a confirmed tx spent and signs again', async () => {
    const dead = signedOver({ parentMined: true })
    const live = signedOver({ parentMined: true })
    wocAnswers((utxo) =>
      `${utxo.txid}.${utxo.vout}` === dead.input
        ? { spentIn: { txid: SPENDER, vin: 0, status: 'confirmed' } }
        : {},
    )
    const sign = vi
      .fn<() => Promise<typeof dead.result>>()
      .mockResolvedValueOnce(dead.result)
      .mockResolvedValueOnce(live.result)
    await expect(signWithCertainInputs(sign, 'main')).resolves.toBe(live.result)
    expect(calls).toEqual([`fail ${dead.result.txid.slice(0, 4)} fresh`, `hide 1 by dddd`])
    expect(txCertified(dead.result.txid)).toBe(false)
  })

  it('refuses when nobody can say the coin is unspent, and fails the fresh signature', async () => {
    const { result } = signedOver({ parentMined: true })
    wocAnswers(() => 'omit')
    const sign = vi.fn(async () => result)
    const err = await signWithCertainInputs(sign, 'main').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputsUnverifiedError)
    expect((err as InputsUnverifiedError).reason).toBe('explorer-silent')
    expect((err as InputsUnverifiedError).code).toBe('INPUTS_UNVERIFIED')
    expect(sign).toHaveBeenCalledOnce()
    expect(calls).toEqual([`fail ${result.txid.slice(0, 4)} fresh`])
  })

  it('spends change of a certified send without asking anyone', async () => {
    const { result, parent } = signedOver({ parentMined: false })
    noteTxCertified(parent, [])
    const fetch = wocAnswers(() => ({}))
    await expect(signWithCertainInputs(async () => result, 'main')).resolves.toBe(result)
    expect(fetch).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('accepts change of an unmined parent a node already holds', async () => {
    const { result, parent } = signedOver({ parentMined: false })
    arcade.set(parent, { kind: 'accepted', status: 'ACCEPTED_BY_NETWORK' })
    await expect(signWithCertainInputs(async () => result, 'main')).resolves.toBe(result)
    expect(calls).toEqual([`arcade ${parent.slice(0, 4)}`])
  })

  it('retires change of a parent Arcade rejected and signs again', async () => {
    const dead = signedOver({ parentMined: false })
    const live = signedOver({ parentMined: true })
    arcade.set(dead.parent, { kind: 'rejected', status: 'REJECTED', reason: 'bad' })
    wocAnswers(() => ({}))
    const sign = vi
      .fn<() => Promise<typeof dead.result>>()
      .mockResolvedValueOnce(dead.result)
      .mockResolvedValueOnce(live.result)
    await expect(signWithCertainInputs(sign, 'main')).resolves.toBe(live.result)
    expect(calls).toEqual([
      `arcade ${dead.parent.slice(0, 4)}`,
      `fail ${dead.result.txid.slice(0, 4)} fresh`,
      `fail ${dead.parent.slice(0, 4)}`,
    ])
    expect(rejected.has(dead.parent)).toBe(true)
  })

  it('retires a coin another install spent before any explorer has seen it', async () => {
    const dead = signedOver({ parentMined: true })
    const live = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const fetch = wocAnswers(() => ({}))
    const sign = vi
      .fn<() => Promise<typeof dead.result>>()
      .mockResolvedValueOnce(dead.result)
      .mockResolvedValueOnce(live.result)
    await expect(signWithCertainInputs(sign, 'main')).resolves.toBe(live.result)
    expect(calls).toEqual([`fail ${dead.result.txid.slice(0, 4)} fresh`, `hide 1 by dddd`])
    const asked = fetch.mock.calls.flatMap(([, init]) =>
      (JSON.parse(init?.body ?? '{"utxos":[]}') as { utxos: Utxo[] }).utxos.map(
        (u) => `${u.txid}.${u.vout}`,
      ),
    )
    expect(asked).not.toContain(dead.input)
  })

  it('judges only after a snapshot read the signature raced', async () => {
    const dead = signedOver({ parentMined: true })
    const live = signedOver({ parentMined: true })
    wocAnswers(() => ({}))
    peerRead = async () => {
      await new Promise((r) => setTimeout(r, 20))
      peerSpent.set(dead.input, SPENDER)
      return { kind: 'read', spent: 1, withdrawn: 0 }
    }
    const sign = vi
      .fn<() => Promise<typeof dead.result>>()
      .mockResolvedValueOnce(dead.result)
      .mockResolvedValueOnce(live.result)
    await expect(signWithCertainInputs(sign, 'main')).resolves.toBe(live.result)
    expect(sign).toHaveBeenCalledTimes(2)
  })

  it('refuses without re-signing when the dead coin is one the caller named', async () => {
    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const sign = vi.fn(async () => dead.result)
    const err = await signWithCertainInputs(sign, 'main', { named: new Set([dead.input]) }).catch(
      (e: unknown) => e,
    )
    expect((err as InputsUnverifiedError).reason).toBe('input-spent')
    expect(sign).toHaveBeenCalledOnce()
    expect(calls).toEqual([`fail ${dead.result.txid.slice(0, 4)} fresh`, `hide 1 by dddd`])
  })

  it('refuses a dead coin when the signature fixes its inputs', async () => {
    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const sign = vi.fn(async () => dead.result)
    const err = await signWithCertainInputs(sign, 'main', { resign: false }).catch((e: unknown) => e)
    expect((err as InputsUnverifiedError).reason).toBe('input-spent')
    expect(sign).toHaveBeenCalledOnce()
  })

  it('passes a tx an enclosing gate already certified', async () => {
    const { result } = signedOver({ parentMined: true })
    noteTxCertified(result.txid, [])
    const fetch = wocAnswers(() => 'omit')
    await expect(signWithCertainInputs(async () => result, 'main')).resolves.toBe(result)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('installSpendCertainty', () => {
  beforeEach(() => {
    calls.length = 0
    peerSpent.clear()
    peerRead = async () => ({ kind: 'throttled' })
    resetSpendCertaintyForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  function fakeWallet(created: unknown, signed: unknown) {
    const wallet = {
      createAction: vi.fn(async () => created),
      signAction: vi.fn(async () => signed),
      abortAction: vi.fn(async () => ({ aborted: true })),
    }
    return { wallet, raw: { ...wallet } }
  }

  it('judges a signable before signAction signs it, and aborts a dead one', async () => {
    resetSignablesForTests()
    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const signable = { signableTransaction: { reference: 'ref-dead', tx: dead.result.tx } }
    const { wallet, raw } = fakeWallet(signable, dead.result)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    await wallet.createAction({ description: 'x' } as never)
    const err = await wallet
      .signAction({ reference: 'ref-dead', spends: {}, options: { acceptDelayedBroadcast: false } } as never)
      .catch((e: unknown) => e)
    expect((err as InputsUnverifiedError).reason).toBe('input-spent')
    expect(raw.signAction).not.toHaveBeenCalled()
    expect(raw.abortAction).toHaveBeenCalledWith({ reference: 'ref-dead' }, undefined)
    expect(calls).toContain('hide 1 by dddd')
  })

  it('signs a signable whose coins clear, and certifies the signed tx', async () => {
    resetSignablesForTests()
    const good = signedOver({ parentMined: true })
    const signable = { signableTransaction: { reference: 'ref-ok', tx: good.result.tx } }
    const final = { txid: 'ab'.repeat(32), tx: [0] }
    const { wallet, raw } = fakeWallet(signable, final)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    await wallet.createAction({ description: 'x' } as never)
    wocAnswers(() => ({}))
    await expect(wallet.signAction({ reference: 'ref-ok', spends: {} } as never)).resolves.toBe(final)
    expect(raw.signAction).toHaveBeenCalledOnce()
    expect(raw.abortAction).not.toHaveBeenCalled()
    expect(txCertified(final.txid)).toBe(true)
  })

  it('does not pretend to judge a createAction that broadcast inline', async () => {
    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const { wallet } = fakeWallet(dead.result, null)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    await expect(
      wallet.createAction({ description: 'x', options: { acceptDelayedBroadcast: false } } as never),
    ).resolves.toBe(dead.result)
    expect(calls).toEqual([])
  })

  it('gates createAction and signAction on the toolbox instance, once', async () => {
    const good = signedOver({ parentMined: true })
    const { wallet, raw } = fakeWallet(good.result, good.result)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    const gated = wallet.createAction
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    expect(wallet.createAction).toBe(gated)

    wocAnswers(() => ({}))
    await expect(wallet.createAction({ description: 'x' } as never)).resolves.toBe(good.result)
    expect(raw.createAction).toHaveBeenCalledOnce()
    expect(txCertified(good.result.txid)).toBe(true)

    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    raw.signAction.mockResolvedValueOnce(dead.result)
    const err = await wallet.signAction({ reference: 'r', spends: {} } as never).catch((e: unknown) => e)
    expect((err as InputsUnverifiedError).reason).toBe('input-spent')
  })

  it('passes a signable result through untouched', async () => {
    const signable = { signableTransaction: { reference: 'r', tx: [1, 2, 3] } }
    const { wallet } = fakeWallet(signable, null)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    const fetch = wocAnswers(() => ({}))
    await expect(wallet.createAction({ description: 'x' } as never)).resolves.toBe(signable)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a createAction whose named input is dead', async () => {
    const dead = signedOver({ parentMined: true })
    peerSpent.set(dead.input, SPENDER)
    const { wallet, raw } = fakeWallet(dead.result, null)
    installSpendCertainty(wallet as unknown as Wallet, 'main')
    const [txid, vout] = dead.input.split('.')
    const err = await wallet
      .createAction({
        description: 'x',
        inputs: [{ outpoint: `${txid!.toUpperCase()}.${vout}`, inputDescription: 'item' }],
      } as never)
      .catch((e: unknown) => e)
    expect((err as InputsUnverifiedError).reason).toBe('input-spent')
    expect(raw.createAction).toHaveBeenCalledOnce()
  })
})
