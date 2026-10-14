/**
 * BRC-251 §Required processing: a deploy whose payload carries a non-empty
 * `req` names processing a later document requires before holders may spend.
 * This wallet implements none, so such a token is unsupported — never in a
 * balance, never selected for a send, never accepted as a receipt.
 *
 * The verdict is a fact of the deploy script, so it is remembered per token
 * once any path has read the deploy.
 */
import type { Beef } from '@bsv/sdk'
import { decodeBsv21Binary } from './decode162'
import { normalizeTokenId } from './types'

const unsupported = new Set<string>()

export function noteTokenRequiresProcessing(tokenId: string): void {
  const id = normalizeTokenId(tokenId)
  if (id) unsupported.add(id)
}

export function tokenRequiresProcessing(tokenId: string): boolean {
  const id = normalizeTokenId(tokenId)
  return !!id && unsupported.has(id)
}

/** Reads the deploy output from a BEEF that carries it; records a refusal. */
export function deployRequiresProcessing(beef: Pick<Beef, 'findTxid'>, tokenId: string): boolean {
  const id = normalizeTokenId(tokenId)
  if (!id) return false
  if (unsupported.has(id)) return true
  const [txid, vout] = id.split('_')
  const script = beef.findTxid(txid!)?.tx?.outputs[Number(vout)]?.lockingScript
  const deploy = script ? decodeBsv21Binary(script) : null
  if (deploy?.role !== 'deploy' || !deploy.payload?.requiresProcessing) return false
  unsupported.add(id)
  return true
}

export function resetRequiredProcessingForTests(): void {
  unsupported.clear()
}
