/// <reference lib="webworker" />
// Read-only projection: large remittance records are cloned in this worker,
// never sent to the renderer. Each request is one bounded storage-lock slice.
const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = async (event: MessageEvent<{
  database: string; userId: number; basketId: number; after?: number; limit: number
}>) => {
  let db: IDBDatabase | undefined
  try {
    const args = event.data
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(args.database)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error('Activity database unavailable'))
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const rows: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('outputs', 'readonly')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Activity read aborted'))
      tx.onerror = () => reject(tx.error)
      const request = tx.objectStore('outputs').index('userId_basketId')
        .openCursor(IDBKeyRange.only([args.userId, args.basketId]))
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || rows.length >= args.limit) return
        if (args.after != null && Number(cursor.primaryKey) <= args.after) {
          // Resume by primary key without re-cloning earlier remittance.
          cursor.continuePrimaryKey(cursor.key, args.after + 1)
          return
        }
        const r = cursor.value
        rows.push({
          outputId: r.outputId, transactionId: r.transactionId, spentBy: r.spentBy,
          basketId: r.basketId, vout: r.vout, txid: r.txid, created_at: r.created_at,
          customInstructions: typeof r.customInstructions === 'string' &&
            r.customInstructions.length <= 4096 ? r.customInstructions : undefined,
        })
        if (rows.length < args.limit) cursor.continue()
      }
    })
    scope.postMessage({ rows })
  } catch {
    scope.postMessage({ error: true })
  } finally {
    db?.close()
  }
}
export {}
