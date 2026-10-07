import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bsv/wallet-toolbox-client', () => ({
  SetupClient: {
    getKeyPair: (privateKey: PrivateKey) => ({ privateKey }),
    getUnlockP2PKH: () => ({
      sign: async () => UnlockingScript.fromHex('00'),
      estimateLength: async () => 108,
    }),
  },
}))
vi.mock('./legacyBeef', () => ({ withVisibleOnChainBeef: <T>(fn: () => Promise<T>) => fn() }))
vi.mock('./derivedChangeEcho', () => ({ rememberDerivedChangeFromTxid: vi.fn(async () => undefined) }))
const submitted: string[] = []
vi.mock('./minerSubmit', () => ({
  submitAtomicBeefToMiners: vi.fn(async (txid: string) => {
    submitted.push(txid)
    return { kind: 'accepted' }
  }),
}))

import { chooseP2pkhSweepUnit, MAX_P2PKH_SWEEP_INPUTS, sweepVisibleP2pkhOutpoints } from './importP2pkhFunding'
import type { ActiveWallet } from './session'

const key = PrivateKey.fromRandom()
const lock = new P2PKH().lock(key.toAddress())

/** A deposit paying `count` coins to {@link key}, packaged as the sweep's input BEEF. */
function deposit(count: number) {
  const tx = new Transaction()
  for (let i = 0; i < count; i++) tx.addOutput({ lockingScript: lock, satoshis: 1_000 + i })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { txid: tx.id('hex'), bin: beef.toBinary() }
}

/** A toolbox stand-in: an unsigned spend of the asked inputs; `refuse` rejects any action holding a coin. */
function walletRefusing(refuse: (outpoints: string[]) => boolean) {
  let n = 0
  const spends: string[][] = []
  const wallet = {
    createAction: vi.fn(async ({ inputs }: { inputs: Array<{ outpoint: string }> }) => {
      const outpoints = inputs.map((i) => i.outpoint)
      const tx = new Transaction()
      for (const op of outpoints) {
        const [txid, vout] = op.split('.')
        tx.addInput({
          sourceTXID: txid!,
          sourceOutputIndex: Number(vout),
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff,
        })
      }
      tx.addOutput({ lockingScript: lock, satoshis: 1 })
      const beef = new Beef()
      beef.mergeTransaction(tx)
      n += 1
      return { signableTransaction: { tx: beef.toBinary(), reference: `ref-${n}` } }
    }),
    signAction: vi.fn(async ({ spends: s }: { spends: Record<number, unknown> }) => {
      const asked = wallet.createAction.mock.calls.at(-1)![0].inputs.map((i) => i.outpoint)
      if (refuse(asked)) throw new Error('rejected')
      spends.push(asked)
      expect(Object.keys(s)).toHaveLength(asked.length)
      const signed = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1 }], spends.length)
      const beef = new Beef()
      beef.mergeTransaction(signed)
      return { txid: signed.id('hex'), tx: beef.toBinaryAtomic(signed.id('hex')) }
    }),
    abortAction: vi.fn(async () => ({ aborted: true })),
  }
  return { active: { wallet, rootKeyHex: key.toHex() } as unknown as ActiveWallet, wallet, spends }
}

beforeEach(() => {
  submitted.length = 0
})

describe('chooseP2pkhSweepUnit', () => {
  it('takes every waiting coin up to the cap, or one alone', () => {
    const coins = Array.from({ length: 150 }, (_, i) => ({ outpoint: `${i}`, txid: 'a', vout: i, satoshis: 1 }))
    expect(chooseP2pkhSweepUnit(coins)).toMatchObject({ kind: 'bundle', coins: { length: MAX_P2PKH_SWEEP_INPUTS } })
    expect(chooseP2pkhSweepUnit(coins.slice(0, 1))).toEqual({ kind: 'single', coin: coins[0] })
    expect(chooseP2pkhSweepUnit(coins, 1)).toEqual({ kind: 'single', coin: coins[0] })
  })
})

describe('sweepVisibleP2pkhOutpoints', () => {
  it('moves every coin in one transaction', async () => {
    const { txid, bin } = deposit(12)
    const outpoints = Array.from({ length: 12 }, (_, i) => `${txid}.${i}`)
    const { active, wallet } = walletRefusing(() => false)

    const results = await sweepVisibleP2pkhOutpoints(active, outpoints, bin)

    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction.mock.calls[0]![0]).toMatchObject({ description: 'Import 12 P2PKH UTXOs' })
    expect(submitted).toHaveLength(1)
    expect(results.every((r) => r.success && r.txid === submitted[0])).toBe(true)
  })

  it('isolates a refused coin by halving and still moves the rest together', async () => {
    const { txid, bin } = deposit(8)
    const outpoints = Array.from({ length: 8 }, (_, i) => `${txid}.${i}`)
    const bad = `${txid}.5`
    const { active, wallet, spends } = walletRefusing((asked) => asked.includes(bad))

    const results = await sweepVisibleP2pkhOutpoints(active, outpoints, bin)

    expect(results.find((r) => r.outpoint === bad)).toMatchObject({ success: false, error: 'rejected' })
    expect(results.filter((r) => r.success).map((r) => r.outpoint).sort()).toEqual(outpoints.filter((o) => o !== bad).sort())
    expect(spends.flat()).not.toContain(bad)
    expect(spends.length).toBeLessThanOrEqual(4)
    expect(wallet.abortAction).toHaveBeenCalledTimes(wallet.createAction.mock.calls.length - spends.length)
  })

  it('reports a coin the package does not hold without sweeping it', async () => {
    const { txid, bin } = deposit(1)
    const { active, wallet } = walletRefusing(() => false)
    const results = await sweepVisibleP2pkhOutpoints(active, [`${txid}.0`, `${txid}.4`], bin)
    expect(results).toEqual([
      { outpoint: `${txid}.4`, success: false, error: 'vout 4 out of range' },
      { outpoint: `${txid}.0`, txid: submitted[0], success: true },
    ])
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
  })
})
