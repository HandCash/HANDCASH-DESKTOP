/**
 * Main-thread cost of the paths behind UI lag on a large wallet.
 * Run with `HANDCASH_PERF=1 ./node_modules/.bin/vitest run src/perf`.
 */
import { beforeAll, describe, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('../wallet/durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('../wallet/walletRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wallet/walletRuntime')>()),
  getWalletRuntime: () => ({ storageNamespace: 'ns', instance: {} }),
  runtimeIsCurrent: () => true,
}))

import { bindAccountLocalKeyScope } from '../wallet/accountLocalKeys'
import { ledgerActivityRows, publishActivityLedger, type LedgerBasket, type LedgerOutput, type LedgerTx } from '../wallet/activityLedger'
import { listActivityFeed, mergeActivityEntries, upsertAppActivity, type ActivityEntry } from '../wallet/appActivity'
import { searchCollectables } from '../wallet/collectableSearch'
import type { Collectable } from '../wallet/collectables'

const TXS = 20_000
const ITEM_OUTPUTS = 10_000
const STORED = 1_000
const ITEMS = 10_000

const hex = (n: number) => n.toString(16).padStart(64, '0')

export function largeLedger(): { txs: LedgerTx[]; outputs: LedgerOutput[]; baskets: LedgerBasket[] } {
  const baskets: LedgerBasket[] = [{ basketId: 1, name: 'default' }, { basketId: 2, name: '1sat' }]
  const txs: LedgerTx[] = Array.from({ length: TXS }, (_, i) => ({
    transactionId: i + 1,
    status: 'completed',
    txid: hex(i + 1),
    satoshis: i % 3 === 0 ? -1_000 - i : 2_000 + i,
    description: i % 5 === 0 ? '' : `payment ${i}`,
    isOutgoing: i % 3 === 0,
    created_at: 1_700_000_000_000 + i * 60_000,
  }))
  const outputs: LedgerOutput[] = Array.from({ length: ITEM_OUTPUTS }, (_, i) => ({
    transactionId: (i * 2) % TXS + 1,
    spentBy: i % 4 === 0 ? ((i * 2 + 7) % TXS) + 1 : null,
    basketId: 2,
    vout: i % 3,
    txid: hex(((i * 2) % TXS) + 1),
    customInstructions: JSON.stringify({ origin: `${hex(i + 50_000)}_0`, name: `Fox #${i}` }),
  }))
  return { txs, outputs, baskets }
}

function largeCollection(): Collectable[] {
  return Array.from({ length: ITEMS }, (_, i) => ({
    outpoint: `${hex(i)}.0`,
    origin: `${hex(i)}_0`,
    name: `Pixel Fox #${i}`,
    app: i % 2 ? 'pixelfoxes' : 'kitkat',
    imageUrl: '',
    satoshis: 1,
    collectionId: `${hex(7)}_0`,
    type: 'image',
    mimeType: 'image/png',
    traits: [
      { name: 'Fur', value: ['red', 'blue', 'gold'][i % 3] },
      { name: 'Eyes', value: ['laser', 'sleepy'][i % 2] },
    ],
    extras: [],
  })) as unknown as Collectable[]
}

function time(label: string, runs: number, fn: () => unknown): number {
  fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]!
  console.info(`[perf] ${label}: ${median.toFixed(2)} ms (median of ${runs})`)
  return median
}

describe.skipIf(!process.env.HANDCASH_PERF)('UI lag on a large wallet', () => {
  const ledger = largeLedger()
  let rows: ActivityEntry[] = []

  beforeAll(() => {
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: `02${'a'.repeat(64)}` })
    rows = ledgerActivityRows(ledger.txs, ledger.outputs, ledger.baskets)
    publishActivityLedger('ns', rows)
    mergeActivityEntries(
      Array.from({ length: STORED }, (_, i) => ({
        id: `stored-${i}`,
        origin: 'shop.example',
        kind: 'spent' as const,
        sats: 500,
        at: 1_700_000_000_000 + i * 1_000_000,
        method: 'createAction',
        txid: hex(900_000 + i),
      })),
    )
  })

  it('history projection', () => {
    console.info(`[perf] ledger rows: ${rows.length} from ${TXS} tx, ${ITEM_OUTPUTS} item outputs`)
    time('history projection (ledgerActivityRows)', 5, () =>
      ledgerActivityRows(ledger.txs, ledger.outputs, ledger.baskets),
    )
    time('structured clone of projection input', 5, () => structuredClone(ledger))
  })

  it('feed rebuild after one write', () => {
    let n = 0
    time('feed rebuild after one write (listActivityFeed 200)', 10, () => {
      upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 1 + n++, method: 'createAction', note: `write ${n}` })
      return listActivityFeed(200)
    })
    time('feed read, no write (listActivityFeed 200)', 10, () => listActivityFeed(200))
    time('one activity write alone (upsertAppActivity)', 10, () =>
      upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 1 + n++, method: 'createAction', note: `write ${n}` }),
    )
    let rebuild = 0
    for (let i = 0; i < 10; i++) {
      upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 1 + n++, method: 'createAction', note: `write ${n}` })
      const started = performance.now()
      listActivityFeed(200)
      rebuild += performance.now() - started
    }
    console.info(`[perf] feed rebuild only, after a write: ${(rebuild / 10).toFixed(2)} ms (mean of 10)`)
  })

  it('collectables search keystroke', () => {
    const items = largeCollection()
    time(`collectables search over ${ITEMS} items`, 10, () => searchCollectables('fox, gold', items))
  })
})
