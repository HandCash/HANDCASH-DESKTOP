/**
 * Bounded-concurrency map over an async work queue.
 * Shared by chain ingest, tip ingest, ordinal import, and outbox flush.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i]!, i)
      }
    }),
  )
  return results
}
