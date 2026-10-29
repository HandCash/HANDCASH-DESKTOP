import { isEthAddress } from '../arcUsdc/address'
import { SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from './assets'
import { createExolixExchange, isBsvAddress, SwapRefusal, writeSwapRecord, type AddressCheck, type SwapRecord } from './exolixSwap'
import type { SignedSwapOffer } from './offer'
import type { SwapRoute } from './routing'

/**
 * Carry out a swap the user confirmed, between coins this wallet holds.
 *
 * Exolix route: check the wallet can pay, open the exchange with this
 * wallet's own payout and refund addresses, check it matches the confirmed
 * quote, record it, then pay the deposit from the wallet's own balance
 * through the normal payment path for that coin (BSV P2PKH send; LTC / BCH
 * coin send, kept broadcasting until it confirms).
 *
 * Direct route: send the take of the offer (`takeSwapOffer`, balance checked
 * first). The wallet locks its side once the maker accepts and carries the
 * swap to its end on its own (`settleRunner.ts`); nobody holds the coins. A
 * direct offer is never silently filled through Exolix instead.
 */

export type SwapStart =
  | { via: 'exolix'; record: SwapRecord }
  | { via: 'direct'; swapId: string; from: SwapAsset; to: SwapAsset; pay: bigint; receive: bigint }

export type SwapDeps = { fetch?: typeof fetch; now?: () => number; takeOffer?: (offer: SignedSwapOffer, lock: bigint) => Promise<{ terms: { swapId: string } }> }

export type SwapWallet = {
  /** This wallet's own receiving address on `asset`. */
  ownAddress(asset: SwapAsset): Promise<string>
  validAddress: AddressCheck
  /** Refuse (throw) unless the wallet can pay `units` of `asset` now. */
  canPay(asset: SwapAsset, units: bigint): Promise<void>
  pay(asset: SwapAsset, address: string, units: bigint): Promise<{ txid: string; status: 'sent' | 'queued' }>
}

export async function runSwap(route: SwapRoute, wallet: SwapWallet, opts: SwapDeps = {}): Promise<SwapStart> {
  if (route.kind === 'direct') {
    const take = opts.takeOffer ?? (async (offer, lock) => (await import('./settleRunner')).takeSwapOffer(offer, lock))
    const record = await take(route.offer, route.lock)
    return { via: 'direct', swapId: record.terms.swapId, from: route.offer.get, to: route.offer.give, pay: route.pay, receive: route.receive }
  }
  return { via: 'exolix', record: await runExolix(route, wallet, opts) }
}

async function runExolix(route: Extract<SwapRoute, { kind: 'exolix' }>, wallet: SwapWallet, opts: SwapDeps): Promise<SwapRecord> {
  const now = opts.now ?? Date.now
  const { from, to } = route.quote
  await wallet.canPay(from, route.pay)
  const own = { withdrawal: await wallet.ownAddress(to), refund: await wallet.ownAddress(from) }
  const exchange = await createExolixExchange(
    { from, to, pay: route.pay, receive: route.receive },
    own,
    { validAddress: wallet.validAddress, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
  )
  const record: SwapRecord = {
    id: exchange.id,
    via: 'exolix',
    from,
    to,
    pay: exchange.pay.toString(),
    receive: exchange.receive.toString(),
    depositAddress: exchange.depositAddress,
    payout: own.withdrawal,
    stage: 'created',
    status: exchange.status,
    createdAt: now(),
    updatedAt: now(),
  }
  writeSwapRecord(record)
  console.info(`[swap] exolix ${exchange.id} created ${unitsToDecimal(from, exchange.pay)} ${SWAP_ASSET_INFO[from].ticker} → ${unitsToDecimal(to, exchange.receive)} ${SWAP_ASSET_INFO[to].ticker}`)
  try {
    const paid = await wallet.pay(from, exchange.depositAddress, exchange.pay)
    const done: SwapRecord = { ...record, stage: 'paid', txid: paid.txid, updatedAt: now() }
    writeSwapRecord(done)
    console.info(`[swap] exolix ${exchange.id} deposit ${paid.status} ${paid.txid}`)
    return done
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    writeSwapRecord({ ...record, stage: 'pay-failed', error, updatedAt: now() })
    console.warn(`[swap] exolix ${exchange.id} deposit failed — ${error}`)
    throw err
  }
}

/** The open wallet: its BSV payment address, UTXO coin keys, and Arc USDC. */
export function walletSwapPorts(bsvAddress: string): SwapWallet {
  const coin = async (asset: Exclude<SwapAsset, 'bsv' | 'arc-usd'>) => (await import('../coinMethods')).coinWalletOf(asset)
  const coins: Partial<Record<Exclude<SwapAsset, 'bsv' | 'arc-usd'>, Awaited<ReturnType<typeof coin>>>> = {}
  const coinOf = async (asset: Exclude<SwapAsset, 'bsv' | 'arc-usd'>) => (coins[asset] ??= await coin(asset))
  return {
    async ownAddress(asset) {
      if (asset === 'bsv') return bsvAddress
      if (asset === 'arc-usd') return (await import('../arcUsdc')).arcUsdWallet.getAddress()
      return (await coinOf(asset)).getAddress()
    },
    validAddress(asset, address) {
      if (asset === 'bsv') return isBsvAddress(address)
      if (asset === 'arc-usd') return isEthAddress(address)
      const wallet = coins[asset]
      if (!wallet) return false
      try {
        wallet.binding.outputScript(address)
        return true
      } catch {
        return false
      }
    },
    async canPay(asset, units) {
      if (asset === 'bsv') {
        const { assertSendableBalanceForReview } = await import('../sendPayment')
        await assertSendableBalanceForReview(Number(units))
        return
      }
      if (asset === 'arc-usd') {
        const spendable = BigInt((await import('../arcUsdc')).arcUsdWallet.readBalance().spendable)
        if (spendable < units) {
          throw new SwapRefusal(
            'insufficient',
            `This wallet can spend ${unitsToDecimal(asset, spendable)} ${SWAP_ASSET_INFO[asset].ticker}, less than ${unitsToDecimal(asset, units)}.`,
          )
        }
        return
      }
      const spendable = BigInt((await coinOf(asset)).readBalance().spendable)
      if (spendable < units) {
        throw new SwapRefusal('insufficient', `This wallet can spend ${unitsToDecimal(asset, spendable)} ${SWAP_ASSET_INFO[asset].ticker}, less than ${unitsToDecimal(asset, units)}.`)
      }
    },
    async pay(asset, address, units) {
      if (asset === 'bsv') {
        const { sendSatsToAddress } = await import('../sendPayment')
        const sent = await sendSatsToAddress({ to: address, satoshis: Number(units), friendLabel: 'Exolix swap' })
        return { txid: sent.txid, status: 'sent' }
      }
      if (asset === 'arc-usd') {
        const paid = await (await import('../arcUsdc')).arcUsdWallet.send({ address, litoshi: units.toString() })
        return { txid: paid.txid, status: paid.status }
      }
      const sent = await (await coinOf(asset)).send({ address, litoshi: units.toString() })
      return { txid: sent.ltcTxid, status: sent.status }
    },
  }
}
