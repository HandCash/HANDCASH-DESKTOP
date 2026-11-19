import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('projects only one account basket and resumes without returning large remittance', async () => {
  const name = 'activity-worker-' + crypto.randomUUID()
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('outputs', { keyPath: 'outputId' })
      store.createIndex('userId_basketId', ['userId', 'basketId'])
    }
    request.onsuccess = () => resolve(request.result)
  })
  await new Promise<void>((resolve) => {
    const tx = db.transaction('outputs', 'readwrite')
    for (let i = 1; i <= 5; i++) tx.objectStore('outputs').put({
      outputId: i, userId: i === 4 ? 2 : 1, basketId: i === 5 ? 9 : 3,
      transactionId: i, spentBy: i === 3 ? 7 : undefined, txid: String(i),
      customInstructions: i === 2 ? 'x'.repeat(400000) : '{"name":"small"}',
      lockingScript: 'must-not-cross-to-renderer',
    })
    tx.oncomplete = () => resolve()
  })
  const messages: Array<{ rows: Array<Record<string, unknown>> }> = []
  let receive!: (event: MessageEvent) => Promise<void>
  vi.stubGlobal('self', {
    set onmessage(fn: typeof receive) { receive = fn },
    postMessage: (message: (typeof messages)[number]) => messages.push(message),
  })
  await import('./activityOutputs.worker')
  await receive({ data: { database: name, userId: 1, basketId: 3, limit: 2 } } as MessageEvent)
  expect(messages[0]!.rows.map(r => r.outputId)).toEqual([1, 2])
  expect(messages[0]!.rows[1]!.customInstructions).toBeUndefined()
  expect(messages[0]!.rows[0]).not.toHaveProperty('lockingScript')
  await receive({ data: { database: name, userId: 1, basketId: 3, after: 2, limit: 2 } } as MessageEvent)
  expect(messages[1]!.rows.map(r => r.outputId)).toEqual([3])
  expect(messages[1]!.rows[0]!.spentBy).toBe(7)
  db.close()
  indexedDB.deleteDatabase(name)
})
