/**
 * One worker per Activity scan, reused across its pages. No wallet data is
 * written. A browser worker failure rejects so Activity keeps its last snapshot;
 * it must not move large IndexedDB record cloning back onto the UI thread.
 */
export function activityOutputProjection() {
  let worker: Worker | null = null
  let unavailable = typeof Worker === 'undefined'
  return {
    async read(args: {
      database: string; userId: number; basketId: number; after?: number; limit: number
    }): Promise<unknown[] | null> {
      if (unavailable) {
        if (typeof window !== 'undefined') throw new Error('Activity background projection unavailable')
        return null
      }
      try {
        worker ??= new Worker(new URL('./activityOutputs.worker.ts', import.meta.url), {
          type: 'module', name: 'handcash-activity-outputs',
        })
        return await new Promise<unknown[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Activity projection timed out')), 8000)
          worker!.onerror = () => {
            clearTimeout(timer)
            reject(new Error('Activity projection unavailable'))
          }
          worker!.onmessage = (event: MessageEvent<{ rows?: unknown[]; error?: boolean }>) => {
            clearTimeout(timer)
            if (event.data.error || !Array.isArray(event.data.rows)) {
              reject(new Error('Activity projection failed'))
            } else resolve(event.data.rows)
          }
          worker!.postMessage(args)
        })
      } catch {
        unavailable = true
        worker?.terminate()
        worker = null
        throw new Error('Activity background projection unavailable')
      }
    },
    close() {
      worker?.terminate()
      worker = null
    },
  }
}
