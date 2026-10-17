/**
 * Buyer pads for ordinal market settlements (`marketSettlementLayout.ts`).
 * A pad is a root-key P2PKH output in basket `market-pads`: the toolbox tracks
 * it but never funds with it, and the buyer signs it with the root key.
 * A settlement returns both pads' satoshis in one output and mints a fresh
 * one-sat pad from change, so a buyer keeps two between purchases.
 */
import { Beef, P2PKH } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { getBeefForTxidCached } from './beefCache'
import { MARKET_PAD_BASKET, MARKET_PAD_COUNT } from './marketSettlementLayout'

export type MarketPad = {
  outpoint: string
  satoshis: number
  lockingScript: string
}

export const MARKET_PAD_TAG = 'market-pad'

export function marketPadOutput(address: string, satoshis = 1): {
  lockingScript: string
  satoshis: number
  outputDescription: string
  basket: string
  tags: string[]
} {
  return {
    lockingScript: new P2PKH().lock(address).toHex(),
    satoshis,
    outputDescription: 'Market ordinal pad',
    basket: MARKET_PAD_BASKET,
    tags: [MARKET_PAD_TAG],
  }
}

async function listPads(active: ActiveWallet): Promise<MarketPad[]> {
  const lock = new P2PKH().lock(active.address).toHex().toLowerCase()
  const page = await active.wallet.listOutputs({
    basket: MARKET_PAD_BASKET,
    include: 'locking scripts',
    limit: 50,
  })
  return (page.outputs ?? [])
    .filter(
      (o) =>
        o.spendable !== false &&
        (o.lockingScript ?? '').toLowerCase() === lock &&
        Number.isSafeInteger(o.satoshis) &&
        o.satoshis >= 1,
    )
    .map((o) => ({
      outpoint: o.outpoint.replace('_', '.'),
      satoshis: o.satoshis,
      lockingScript: o.lockingScript!,
    }))
    .sort((a, b) => a.satoshis - b.satoshis)
}

/**
 * Two pads and the BEEF that carries them. Missing pads are minted in one
 * transaction that is accepted by miners before a settlement chains on it.
 */
export async function ensureMarketPads(
  active: ActiveWallet,
): Promise<{ pads: MarketPad[]; beef: Beef }> {
  let pads = await listPads(active)
  if (pads.length < MARKET_PAD_COUNT) {
    const missing = MARKET_PAD_COUNT - pads.length
    const created = await active.wallet.createAction({
      description: 'Market ordinal pads',
      labels: ['market-v3', MARKET_PAD_TAG],
      outputs: Array.from({ length: missing }, () => marketPadOutput(active.address)),
      options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: true },
    })
    const txid = created.txid?.toLowerCase() ?? ''
    const atomic = created.tx ? Array.from(created.tx) : []
    if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) {
      throw new Error('Market pad transaction was not signed')
    }
    const { registerSignedSend, propagateSignedSend } = await import('./signedSendLifecycle')
    const handle = await registerSignedSend({ txid, atomicBeef: atomic, flow: 'market_pad' })
    const result = await propagateSignedSend(handle)
    if (result.kind !== 'accepted') {
      throw new Error('Market pads are not accepted by miners yet. Try again shortly.')
    }
    pads = await listPads(active)
    if (pads.length < MARKET_PAD_COUNT) {
      throw new Error('Market pads are missing after minting')
    }
  }
  const chosen = pads.slice(0, MARKET_PAD_COUNT)
  const beef = new Beef()
  for (const pad of chosen) {
    const padBeef = await getBeefForTxidCached(active, pad.outpoint.slice(0, 64), {
      needProof: true,
      allowUnprovenRawTx: true,
    })
    beef.mergeBeef(padBeef.toBinary())
  }
  return { pads: chosen, beef }
}
