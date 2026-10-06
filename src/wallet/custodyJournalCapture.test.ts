import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const owner = { identityKey: '02' + 'c3'.repeat(32), accountIndex: 0, chain: 'main' as const }
const txid = 'ab'.repeat(32)

function provider(rows: Record<string, unknown>[]) {
  return {
    findTransactions: vi.fn(async () => [{ transactionId: 7, txid }]),
    findOutputs: vi.fn(async (args: { partial: { spendable?: boolean; transactionId?: number } }) =>
      args.partial.transactionId === 7
        ? rows
        : rows.filter((r) => Boolean(r.spendable) === args.partial.spendable),
    ),
    findOutputBaskets: vi.fn(async () => [
      { basketId: 1, name: 'default' },
      { basketId: 2, name: '1sat' },
    ]),
    findOutputTags: vi.fn(async () => [{ outputTagId: 5, tag: 'origin:x' }]),
    findOutputTagMaps: vi.fn(async (args: { partial: { outputId?: number } }) =>
      args.partial.outputId === 12 || args.partial.outputId === undefined
        ? [{ outputId: 12, outputTagId: 5 }]
        : [],
    ),
  }
}

function walletOver(sp: ReturnType<typeof provider>) {
  return {
    createAction: vi.fn(async () => ({ txid })),
    signAction: vi.fn(async () => ({ txid })),
    internalizeAction: vi.fn(async () => ({ accepted: true })),
    relinquishOutput: vi.fn(async () => ({ relinquished: true })),
    storage: { runAsStorageProvider: async <T,>(fn: (sp: unknown) => Promise<T>) => fn(sp) },
  }
}

const rows = [
  { outputId: 11, transactionId: 7, basketId: 1, vout: 0, satoshis: 900, spendable: true, derivationPrefix: 'p', derivationSuffix: 's' },
  { outputId: 12, transactionId: 7, basketId: 2, vout: 1, satoshis: 1, spendable: true, customInstructions: '{"origin":"o_0","name":"Cat"}' },
  { outputId: 13, transactionId: 7, vout: 2, satoshis: 5000, spendable: false },
]

describe('custody journal capture', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('maps toolbox rows to the internalizeAction spec that recovers them', async () => {
    const { recipeFromRow } = await import('./custodyJournalCapture')
    expect(recipeFromRow({ derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: '03ff' }, 'default', [])).toEqual({
      p: 'wallet payment', prefix: 'p', suffix: 's', sender: '03ff',
    })
    // An item tip is never recovered as spendable change.
    expect(recipeFromRow({ derivationPrefix: 'p', derivationSuffix: 's' }, '1sat', ['t'])).toEqual({
      p: 'basket insertion', basket: '1sat', tags: ['t'],
    })
    expect(recipeFromRow({}, undefined, undefined)).toBeNull()
  })

  it('keeps replayable custom instructions: provenance dropped, item text trimmed to the SDK cap', async () => {
    const { replayableCustomInstructions } = await import('./custodyJournalCapture')
    const withProof = JSON.stringify({ origin: 'o_0', name: 'Cat', provenance: { beefB64: 'x'.repeat(5000) } })
    expect(JSON.parse(replayableCustomInstructions(withProof))).toEqual({ origin: 'o_0', name: 'Cat' })
    const longName = JSON.stringify({ origin: 'o_0', name: 'n'.repeat(3000) })
    expect(replayableCustomInstructions(longName).length).toBeLessThanOrEqual(1000)
    expect(replayableCustomInstructions('not json'.repeat(200))).toBe('')
  })

  it('journals every action before it returns, and a relinquish as a release', async () => {
    const sp = provider(rows)
    const wallet = walletOver(sp)
    const { installCustodyJournal } = await import('./custodyJournalCapture')
    const { custodyEntries, unspentCustodyOutputs } = await import('./custodyJournal')
    installCustodyJournal(wallet as never, owner)
    installCustodyJournal(wallet as never, owner)

    await wallet.createAction({ description: 'x' } as never)
    expect(custodyEntries(owner)).toEqual([
      { k: 'out', op: `${txid}.0`, sats: 900, r: { p: 'wallet payment', prefix: 'p', suffix: 's' } },
      {
        k: 'out',
        op: `${txid}.1`,
        sats: 1,
        r: { p: 'basket insertion', basket: '1sat', ci: '{"origin":"o_0","name":"Cat"}', tags: ['origin:x'] },
      },
    ])
    await wallet.relinquishOutput({ basket: '1sat', output: `${txid}.1` } as never)
    expect(unspentCustodyOutputs(owner).map((o) => o.op)).toEqual([`${txid}.0`])
  })

  it('never fails the action when the journal cannot read the toolbox', async () => {
    const sp = provider(rows)
    sp.findTransactions.mockRejectedValue(new Error('idb closed'))
    const wallet = walletOver(sp)
    const { installCustodyJournal } = await import('./custodyJournalCapture')
    installCustodyJournal(wallet as never, owner)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(wallet.createAction({ description: 'x' } as never)).resolves.toEqual({ txid })
  })

  it('sweeps every row, spendable or not', async () => {
    const sp = provider(rows.map((r) => ({ ...r, txid })))
    const { journalAllToolboxOutputs } = await import('./custodyJournalCapture')
    expect(await journalAllToolboxOutputs(walletOver(sp), owner)).toEqual({ added: 2, rows: 3 })
  })
})
