/**
 * The last validated holdings list, per identity. Prompts and menus read it in
 * memory; custody decisions always re-read the basket.
 */

export type HeldBntAsset = { assetId: string; kind: 'token' | 'item'; sym?: string; name?: string; imageUrl?: string }

let held: { identityKey: string; assets: HeldBntAsset[] } | null = null

export function rememberHeldBntAssets(identityKey: string, assets: readonly HeldBntAsset[]): void {
  held = {
    identityKey: identityKey.toLowerCase(),
    assets: assets.map(({ assetId, kind, sym, name, imageUrl }) => ({
      assetId,
      kind,
      ...(sym ? { sym } : {}),
      ...(name ? { name } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    })),
  }
}

export function heldBntAssets(identityKey: string | undefined): readonly HeldBntAsset[] {
  return heldBntAssetsListed(identityKey) ? held!.assets : []
}

/** False until this identity's holdings were listed this session: an empty list then means none held. */
export function heldBntAssetsListed(identityKey: string | undefined): boolean {
  return !!held && !!identityKey && held.identityKey === identityKey.toLowerCase()
}

export function clearHeldBntAssets(): void {
  held = null
}
