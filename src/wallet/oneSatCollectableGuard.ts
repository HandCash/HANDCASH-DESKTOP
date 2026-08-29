/**
 * Latch 1sat collectables so Refresh / heal / reimport cannot refile them as
 * BSV-21 tokens or generic NFT cards.
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
 * Latch only real collection NFTs. Collection-less leftovers (blank 1sat-ft
 * hops, remittance-only splits) must re-probe — otherwise Refresh files them
 * as collectables, then strips them as bare-origin, and they vanish.
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

export type TokenRoutedTip = { outpoint: string }

/**
 * After classify: pull known collectables out of the BSV-21 / NFT bucket.
 * Same outpoint must not be both a collectable and a token.
 */
export function keepCollectablesOutOfTokenRoute<
  T extends CollectableRemittance,
  U extends TokenRoutedTip,
>(
  oneSats: T[],
  tokenTips: U[],
  knownCollectableKeys: Iterable<string>,
  remittanceByOutpoint?: ReadonlyMap<string, Partial<CollectableRemittance>>,
): { oneSats: T[]; tokenTips: U[]; rescued: string[] } {
  const known = collectableKeySet(knownCollectableKeys)
  if (known.size === 0 || tokenTips.length === 0) {
    return { oneSats, tokenTips, rescued: [] }
  }

  const already = collectableKeySet(oneSats.map((item) => item.outpoint))
  const kept: U[] = []
  const rescued: string[] = []
  const extra: T[] = []

  for (const tip of tokenTips) {
    const op = wireCollectableOutpoint(tip.outpoint)
    if (!op || !known.has(op)) {
      kept.push(tip)
      continue
    }
    rescued.push(op)
    if (already.has(op)) continue
    already.add(op)
    const rem = remittanceByOutpoint?.get(op)
    extra.push(
      applyCollectableRemittance(
        { outpoint: op, ...(rem ?? {}) } as T,
        rem,
      ),
    )
  }

  if (rescued.length === 0) {
    return { oneSats, tokenTips, rescued }
  }
  return {
    oneSats: extra.length > 0 ? [...oneSats, ...extra] : oneSats,
    tokenTips: kept,
    rescued,
  }
}

/** Drop token-import candidates that are already in basket `1sat`. */
export function skipTokenImportForBasketHeld<U extends TokenRoutedTip>(
  tokenTips: U[],
  basketKeys: Iterable<string>,
): { tokenTips: U[]; skipped: string[] } {
  const held = collectableKeySet(basketKeys)
  if (held.size === 0) return { tokenTips, skipped: [] }
  const skipped: string[] = []
  const next: U[] = []
  for (const tip of tokenTips) {
    const op = wireCollectableOutpoint(tip.outpoint)
    if (op && held.has(op)) {
      skipped.push(op)
      continue
    }
    next.push(tip)
  }
  return { tokenTips: next, skipped }
}
