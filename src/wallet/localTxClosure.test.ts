import { describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import {
  failLocalTxClosure,
  inputTxidsOfRawTx,
  orphanedDescendants,
  planFailureClosure,
  type ClosureStorage,
} from './localTxClosure'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)
const E = 'e'.repeat(64)

describe('orphanedDescendants', () => {
  it('returns nothing when no live tx spends a failed one', () => {
    expect(
      orphanedDescendants(new Set([A]), [
        { txid: B, inputTxids: [C] },
        { txid: D, inputTxids: [E] },
      ]),
    ).toEqual([])
  })

  it('walks the whole chain, parents before children', () => {
    // A (failed) → B → C → D ; E is unrelated.
    const orphans = orphanedDescendants(new Set([A]), [
      { txid: D, inputTxids: [C] },
      { txid: C, inputTxids: [B] },
      { txid: E, inputTxids: ['f'.repeat(64)] },
      { txid: B, inputTxids: [A, 'f'.repeat(64)] },
    ])
    expect(orphans).toEqual([B, C, D])
  })

  it('handles a child spending two failed parents once', () => {
    const orphans = orphanedDescendants(new Set([A, B]), [{ txid: C, inputTxids: [A, B] }])
    expect(orphans).toEqual([C])
  })

  it('is case-insensitive on txids', () => {
    expect(
      orphanedDescendants(new Set([A.toUpperCase()]), [{ txid: B, inputTxids: [A] }]),
    ).toEqual([B])
  })
})

describe('planFailureClosure', () => {
  it('names every decision: what fails, what is kept and why, what to retire again', () => {
    // A failed. B → C both live off A; C is on chain. D also spends A and dies.
    const plan = planFailureClosure({
      failed: new Set([A]),
      live: [
        { txid: B, inputTxids: [A] },
        { txid: C, inputTxids: [B] },
        { txid: D, inputTxids: [A] },
      ],
      chain: new Map([[C, 'present']]),
    })
    expect(plan.fail).toEqual([D])
    expect(plan.keep).toEqual(
      expect.arrayContaining([
        { txid: C, reason: 'onChain' },
        { txid: B, reason: 'ancestorOfOnChain' },
      ]),
    )
    expect(plan.keep).toHaveLength(2)
    expect(plan.retireOutputsOf).toEqual([A])
  })

  it('treats an unknown chain answer as absence — wallet state decides', () => {
    const plan = planFailureClosure({
      failed: new Set([A]),
      live: [{ txid: B, inputTxids: [A] }],
      chain: new Map([[B, 'unknown']]),
    })
    expect(plan.fail).toEqual([B])
    expect(plan.keep).toEqual([])
  })
})

function rawTxSpending(parents: readonly string[]): number[] {
  const key = PrivateKey.fromRandom()
  const tx = new Transaction()
  for (const parent of parents) {
    tx.addInput({
      sourceTXID: parent,
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(key.toAddress()),
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  return tx.toBinary()
}

describe('inputTxidsOfRawTx', () => {
  it('reads the parents out of the raw bytes, deduplicated', () => {
    const raw = rawTxSpending([A, B, A])
    expect(inputTxidsOfRawTx(raw).sort()).toEqual([A, B])
  })

  it('is empty for missing or unreadable bytes', () => {
    expect(inputTxidsOfRawTx(undefined)).toEqual([])
    expect(inputTxidsOfRawTx([])).toEqual([])
    expect(inputTxidsOfRawTx([1, 2, 3])).toEqual([])
  })
})

type Row = { transactionId: number; txid: string; status: string; rawTx?: number[] }

/** In-memory storage with toolbox `updateTransactionStatus('failed')` semantics. */
function fakeStorage(rows: Row[], outputs: Array<{ outputId: number; txid: string; spendable: boolean; spentBy?: number }>) {
  const statusLog: Array<[string, number]> = []
  const sp: ClosureStorage = {
    findTransactions: vi.fn(async (args) => {
      if (args.paged.offset > 0) return []
      return rows
        .filter((r) => !args.status || args.status.includes(r.status))
        .map((r) => (args.noRawTx ? { ...r, rawTx: undefined } : r))
    }),
    updateTransactionStatus: vi.fn(async (status, transactionId) => {
      statusLog.push([status, transactionId])
      const row = rows.find((r) => r.transactionId === transactionId)
      if (!row) throw new Error('no row')
      row.status = status
      if (status === 'failed') {
        // Toolbox: release inputs (parent outputs back to spendable), retire own.
        for (const parent of inputTxidsOfRawTx(row.rawTx)) {
          for (const o of outputs) if (o.txid === parent && o.spentBy === transactionId) {
            o.spendable = true
            o.spentBy = undefined
          }
        }
        for (const o of outputs) if (o.txid === row.txid) {
          o.spendable = false
          o.spentBy = undefined
        }
      }
    }),
    findOutputs: vi.fn(async (args) => {
      if (args.paged.offset > 0) return []
      return outputs.filter((o) => o.txid === args.partial.txid)
    }),
    updateOutput: vi.fn(async (outputId, patch) => {
      const o = outputs.find((x) => x.outputId === outputId)
      if (o) {
        o.spendable = patch.spendable
        o.spentBy = patch.spentBy
      }
    }),
  }
  return { sp, statusLog, rows, outputs }
}

describe('failLocalTxClosure', () => {
  it('is a no-op when nothing has failed', async () => {
    const { sp, statusLog } = fakeStorage(
      [{ transactionId: 1, txid: A, status: 'unproven', rawTx: rawTxSpending([E]) }],
      [],
    )
    const outcome = await failLocalTxClosure(sp)
    expect(outcome).toEqual({ failed: [], keptOnChain: [] })
    expect(statusLog).toEqual([])
  })

  it('fails every live descendant of a failed tx and leaves no dead output spendable', async () => {
    // A failed by the toolbox alone. Its output 10 was already spent by B, so
    // it sits spendable=false / spentBy=B — failing B naïvely would restore it.
    // B (unproven) spends A; C (sending) spends B; D is unrelated.
    const { sp, statusLog, rows, outputs } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'failed' },
        { transactionId: 2, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
        { transactionId: 3, txid: C, status: 'sending', rawTx: rawTxSpending([B]) },
        { transactionId: 4, txid: D, status: 'unproven', rawTx: rawTxSpending([E]) },
      ],
      [
        { outputId: 10, txid: A, spendable: false, spentBy: 2 },
        { outputId: 20, txid: B, spendable: false, spentBy: 3 },
        { outputId: 30, txid: C, spendable: true },
        { outputId: 40, txid: D, spendable: true },
      ],
    )
    const outcome = await failLocalTxClosure(sp)
    expect(outcome.failed).toEqual([C, B]) // leaves first
    expect(outcome.keptOnChain).toEqual([])
    expect(statusLog).toEqual([
      ['failed', 3],
      ['failed', 2],
    ])
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'unproven'])
    // The invariant: no output of a dead tx is spendable; the live tx is untouched.
    expect(outputs.find((o) => o.outputId === 10)).toMatchObject({ spendable: false, spentBy: undefined })
    expect(outputs.find((o) => o.outputId === 20)).toMatchObject({ spendable: false, spentBy: undefined })
    expect(outputs.find((o) => o.outputId === 30)).toMatchObject({ spendable: false })
    expect(outputs.find((o) => o.outputId === 40)).toMatchObject({ spendable: true })
  })

  it('takes the closure of a caller-supplied seed in the same pass', async () => {
    const { sp, rows } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'unproven', rawTx: rawTxSpending([E]) },
        { transactionId: 2, txid: B, status: 'nosend', rawTx: rawTxSpending([A]) },
      ],
      [],
    )
    const outcome = await failLocalTxClosure(sp, { seedTxids: [A] })
    expect(outcome.failed).toEqual([B])
    // The seed itself is the caller's to fail; only its descendants are taken.
    expect(rows[0]?.status).toBe('unproven')
    expect(rows[1]?.status).toBe('failed')
  })

  it('leaves a descendant the chain already has, and names it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sp, rows } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'failed' },
        { transactionId: 2, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
        { transactionId: 3, txid: C, status: 'unproven', rawTx: rawTxSpending([A]) },
      ],
      [],
    )
    const outcome = await failLocalTxClosure(sp, {
      txExistsOnChain: async (txid) => (txid === B ? true : false),
    })
    expect(outcome.failed).toEqual([C])
    expect(outcome.keptOnChain).toEqual([B])
    expect(rows[1]?.status).toBe('unproven')
    expect(rows[2]?.status).toBe('failed')
    expect(warn.mock.calls.some(([m]) => String(m).includes('parent verdict is wrong'))).toBe(true)
    warn.mockRestore()
  })

  it('does not fail a live spend of a confirmed descendant', async () => {
    // A failed locally, B is already on chain, C spends only B. Marking B dead
    // and then failing C restores B's outputs — the doubled balance, one hop
    // further down. D spends A directly and still fails.
    const { sp, rows, outputs } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'failed' },
        { transactionId: 2, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
        { transactionId: 3, txid: C, status: 'sending', rawTx: rawTxSpending([B]) },
        { transactionId: 4, txid: D, status: 'unproven', rawTx: rawTxSpending([A]) },
      ],
      [{ outputId: 20, txid: B, spendable: false, spentBy: 3 }],
    )
    const outcome = await failLocalTxClosure(sp, {
      txExistsOnChain: async (txid) => txid === B,
    })
    expect(outcome.failed).toEqual([D])
    expect(outcome.keptOnChain).toEqual([B])
    expect(rows.find((r) => r.txid === C)?.status).toBe('sending')
    expect(rows.find((r) => r.txid === B)?.status).toBe('unproven')
    expect(outputs.find((o) => o.outputId === 20)).toMatchObject({
      spendable: false,
      spentBy: 3,
    })
  })

  it('leaves the live parent of a confirmed descendant alone', async () => {
    // C is on chain and spends E, so failing E would restore inputs the chain
    // has consumed. B spends the failed A and leads nowhere confirmed, so it fails.
    const { sp, rows } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'failed' },
        { transactionId: 2, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
        { transactionId: 5, txid: E, status: 'unproven', rawTx: rawTxSpending([A]) },
        { transactionId: 3, txid: C, status: 'sending', rawTx: rawTxSpending([E]) },
      ],
      [],
    )
    const outcome = await failLocalTxClosure(sp, {
      txExistsOnChain: async (txid) => txid === C,
    })
    expect(outcome.failed).toEqual([B])
    expect(outcome.keptOnChain).toEqual([C])
    expect(rows.find((r) => r.txid === E)?.status).toBe('unproven')
    expect(rows.find((r) => r.txid === C)?.status).toBe('sending')
  })

  it('treats an unknown chain answer as not-on-chain (wallet state decides)', async () => {
    const { sp, rows } = fakeStorage(
      [
        { transactionId: 1, txid: A, status: 'failed' },
        { transactionId: 2, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
      ],
      [],
    )
    await failLocalTxClosure(sp, { txExistsOnChain: async () => null })
    expect(rows[1]?.status).toBe('failed')
  })
})
