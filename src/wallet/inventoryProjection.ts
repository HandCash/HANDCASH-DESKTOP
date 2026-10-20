import { getCachedCollectables, type Collectable } from './collectables'
import { ITEM_STORAGE_BASKET, TOKEN_BASKET } from './assetBaskets'
import { heldBntAssets, type HeldBntAsset } from './bnt/heldAssets'
import { getActiveWallet } from './session'
import { toUnderscoreOutpoint } from './outpointFormat'

export type HeldInventoryProjection = {
  outputs: unknown[]
  totalOutputs: number
}

function originTag(origin: string): string {
  return toUnderscoreOutpoint(origin)
}

function collectableOutput(item: Collectable): Record<string, unknown> {
  const origin = originTag(item.origin)
  const tags: string[] = [`origin:${origin}`, `name:${item.name}`]
  if (item.app) tags.push(`app:${item.app}`)
  if (item.collectionId) tags.push(`collection:${item.collectionId}`)
  return {
    outpoint: item.outpoint,
    satoshis: item.satoshis,
    tags,
  }
}

function tokenOutput(asset: HeldBntAsset): Record<string, unknown> {
  return {
    tags: [TOKEN_BASKET, `${TOKEN_BASKET}:${asset.assetId}`],
    customInstructions: JSON.stringify({ sym: asset.sym ?? asset.name ?? asset.assetId.slice(0, 8) }),
  }
}

/**
 * Account-scoped materialized view of held inventory.
 *
 * Collectables own the durable snapshot and reconcile it from Toolbox; held
 * tokens are the last validated holdings list. Consumers read this projection in memory; they never rescan a basket
 * to render a prompt, build a menu, or answer a market inventory request.
 * Custody decisions still use the exact output and transaction paths.
 */
export function heldInventoryOutputs(
  basket: unknown,
): HeldInventoryProjection | null {
  if (typeof basket !== 'string') return null
  const name = basket.trim()
  if (name === ITEM_STORAGE_BASKET || name === `p ${ITEM_STORAGE_BASKET} all`) {
    const outputs = getCachedCollectables().map(collectableOutput)
    return { outputs, totalOutputs: outputs.length }
  }
  if (name === TOKEN_BASKET || name === `p ${TOKEN_BASKET} all`) {
    const outputs = heldBntAssets(getActiveWallet()?.identityKey)
      .filter((asset) => asset.kind === 'token')
      .map(tokenOutput)
    return { outputs, totalOutputs: outputs.length }
  }
  return null
}
