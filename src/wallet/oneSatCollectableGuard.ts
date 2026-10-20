/**
 * Latch 1sat collectables so Refresh / heal / reimport cannot refile them as
 * tokens or generic NFT cards.
 *
 * Once an outpoint is a collectable (importedOneSat mark, basket `1sat`,
 * remittance, or BRC-150 origin) it stays basket `1sat`. Token import and
 * indexer identity must not win on a later pass.
 */
export function wireCollectableOutpoint(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

export type CollectableRemittance = {
  outpoint: string
  origin?: string
  name?: string
  app?: string
  collectionId?: string
}

export function collectableKeySet(outpoints: Iterable<string>): Set<string> {
  const keys = new Set<string>()
  for (const raw of outpoints) {
    const op = wireCollectableOutpoint(raw)
    if (op) keys.add(op)
  }
  return keys
}

export function isLatchedCollectable(
  outpoint: string,
  known: ReadonlySet<string>,
): boolean {
  const op = wireCollectableOutpoint(outpoint)
  return op.length > 0 && known.has(op)
}

/**
 * Cache only real collection NFTs. Collection-less dust must re-probe;
 * otherwise Refresh can misfile it as a collectable.
 */
export function collectableLatchHolds(
  remittance?: { collectionId?: string } | null,
): boolean {
  return Boolean(remittance?.collectionId?.trim())
}

/**
 * Merge cached remittance onto an import candidate so heal/reimport keeps the
 * collectable identity (origin / name) instead of painting tip-as-origin NFT.
 */
export function applyCollectableRemittance<T extends CollectableRemittance>(
  item: T,
  remittance: Partial<CollectableRemittance> | undefined,
): T {
  if (!remittance) return item
  const origin = remittance.origin?.trim() || item.origin
  const name = remittance.name?.trim() || item.name
  const app = remittance.app?.trim() || item.app
  const collectionId = remittance.collectionId?.trim() || item.collectionId
  return {
    ...item,
    ...(origin ? { origin } : {}),
    ...(name ? { name } : {}),
    ...(app ? { app } : {}),
    ...(collectionId ? { collectionId } : {}),
  }
}
