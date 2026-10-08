import { describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

const spendWaiting = vi.hoisted(() => ({ value: false }))
vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => spendWaiting.value,
}))
vi.mock('./yieldToUi', () => ({ yieldToUi: () => Promise.resolve() }))

import { fillItemScripts, type ScriptRow } from './itemScriptFill'

function txWithOutputs(n: number): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    })
  }
  return tx
}

function walletWith(txs: Transaction[]) {
  const byId = new Map(txs.map((tx) => [tx.id('hex'), tx.toBinary()]))
  const reads: string[] = []
  const storage = {
    isActiveStorageProvider: () => true,
    runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
      fn({
        getProvenOrRawTx: async (txid: string) => {
          reads.push(txid)
          const rawTx = byId.get(txid)
          return rawTx ? { rawTx } : undefined
        },
      }),
  }
  return { wallet: { storage } as never, reads }
}

const keyOf = (o: string) => o.replace('.', '_')

describe('fillItemScripts', () => {
  it('carries known scripts and reads each missing transaction once', async () => {
    spendWaiting.value = false
    const a = txWithOutputs(2)
    const b = txWithOutputs(1)
    const { wallet, reads } = walletWith([a, b])
    const rows: ScriptRow[] = [
      { outpoint: `${a.id('hex')}.0` },
      { outpoint: `${a.id('hex')}.1` },
      { outpoint: `${b.id('hex')}.0` },
    ]
    const known = new Map([[`${b.id('hex')}_0`, 'carried']])
    const outcome = await fillItemScripts(wallet, rows, {
      known,
      keyOf,
      stillCurrent: () => true,
    })
    expect(reads).toEqual([a.id('hex')])
    expect(rows[0]!.lockingScript).toBe(a.outputs[0]!.lockingScript.toHex())
    expect(rows[1]!.lockingScript).toBe(a.outputs[1]!.lockingScript.toHex())
    expect(rows[2]!.lockingScript).toBe('carried')
    expect(outcome).toMatchObject({ filled: 2, missing: 0, stoppedFor: null })
  })

  it('stops before the next read when a send is waiting', async () => {
    spendWaiting.value = true
    const a = txWithOutputs(1)
    const { wallet, reads } = walletWith([a])
    const rows: ScriptRow[] = [{ outpoint: `${a.id('hex')}_0` }]
    const outcome = await fillItemScripts(wallet, rows, {
      known: new Map(),
      keyOf,
      stillCurrent: () => true,
    })
    expect(reads).toEqual([])
    expect(rows[0]!.lockingScript).toBeUndefined()
    expect(outcome).toMatchObject({ filled: 0, missing: 1, stoppedFor: 'send' })
    expect(outcome.unread.has(rows[0]!)).toBe(true)
    spendWaiting.value = false
  })

  it('leaves a row unknown when its transaction is not stored', async () => {
    spendWaiting.value = false
    const { wallet } = walletWith([])
    const rows: ScriptRow[] = [{ outpoint: `${'ab'.repeat(32)}.3` }]
    const outcome = await fillItemScripts(wallet, rows, {
      known: new Map(),
      keyOf,
      stillCurrent: () => true,
    })
    expect(rows[0]!.lockingScript).toBeUndefined()
    expect(outcome).toMatchObject({ filled: 0, missing: 1, stoppedFor: null })
    expect(outcome.unread.size).toBe(0)
  })
})
