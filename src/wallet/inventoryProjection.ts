import { getCachedCollectables, type Collectable } from './collectables'
import { getCachedFungibles } from './token/list'
import { isTokenFilingBasket } from './token/filing'
import { bsv21Tags } from './token/types'
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

/**
 * Account-scoped materialized view of held inventory.
 *
 * Collectables and fungibles own the durable snapshots and reconcile them from
 * Toolbox. Consumers read this projection in memory; they never rescan a basket
 * to render a prompt, build a menu, or answer a market inventory request.
 * Custody decisions still use the exact output and transaction paths.
 */
export function heldInventoryOutputs(
  basket: unknown,
): HeldInventoryProjection | null {
  if (typeof basket !== 'string') return null
  const name = basket.trim()
  if (name === '1sat' || name === 'p 1sat all') {
    const outputs = getCachedCollectables().map(collectableOutput)
    return { outputs, totalOutputs: outputs.length }
  }
  if (
    isTokenFilingBasket(name) ||
    name === 'p bsv21 all' ||
    name === 'p p2pft all'
  ) {
    const outputs = getCachedFungibles().map((token) => {
      const tokenId = originTag(token.tokenId)
      return {
        outpoint: token.outpoint,
        satoshis: 1,
        tags: bsv21Tags({
          tokenId,
          amt: token.amt,
          sym: token.sym,
          ...(token.icon ? { icon: token.icon } : {}),
          op: 'transfer',
        }),
      }
    })
    return { outputs, totalOutputs: outputs.length }
  }
  return null
}
