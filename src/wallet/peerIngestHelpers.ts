/** Shared helpers for peer settle / remittance ingest paths. */

export function alreadyInternalizedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /already (?:spent|imported|internalized|in (?:the )?wallet|ours)/i.test(
    msg,
  )
}

/** Toolbox refuses to merge into a local row that is `failed` / `unmined` / etc. */
export function invalidInternalizeStatusError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /internalizeAction has invalid status/i.test(msg)
}

/**
 * Retry `internalizeAction` after restoring a ghost-failed (or unmined) local
 * row that explorers prove is on chain. Does not unfail on explorer silence.
 */
export async function withRestoredInternalizeStatus<T>(
  txid: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!invalidInternalizeStatusError(err)) throw err
    const { restoreOnChainLocalTx } = await import('./staleOutputRelease')
    const restored = await restoreOnChainLocalTx(txid)
    if (!restored) throw err
    return await run()
  }
}

export async function fetchAtomicBeefFromUrl(
  url: string,
): Promise<number[] | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > 0 ? Array.from(buf) : undefined
  } catch {
    return undefined
  }
}
