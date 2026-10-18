import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountLocalKey } from './accountLocalKeys'
import { brc29PrivateKey, type Remittance } from './brc29Keys'
import { durableRemoveItem, durableSetItem } from './durableStorage'
import { getMarketListingAuthorization, type MarketListingAuthorization } from './marketListing'
import { storageRegistry } from '../storage/registry'
import type { ActiveWallet } from './session'

const unspent = vi.hoisted(() => ({ utxos: [] as Array<{ outpoint: string; txid: string; vout: number; satoshis: number }> }))
const beefs = vi.hoisted(() => new Map<string, number[]>())

vi.mock('./chainProbeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chainProbeClient')>()),
  cloudAddressUnspent: vi.fn(async () => ({ utxos: unspent.utxos, sats: 0 })),
}))
vi.mock('./beefCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./beefCache')>()),
  getAtomicBeefBinaryForTxid: vi.fn(async (_active: unknown, txid: string) => {
    const atomic = beefs.get(txid)
    if (!atomic) throw new Error('no beef')
    return atomic
  }),
}))
vi.mock('./deviceSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deviceSync')>()),
  scheduleHistoryBackupPush: vi.fn(),
}))

const { collectUnreceiptedMarketProceeds, payoutMayHoldUnreceiptedSale } = await import('./marketSettlement')

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const payout: Remittance = { derivationPrefix: 'cHJlZml4', derivationSuffix: 'cGF5b3V0', senderIdentityKey: identityKey }
const listingRemittance: Remittance = { ...payout, derivationSuffix: 'bGlzdA==' }
const listingTxid = 'a'.repeat(64)
const storageKey = (): string => accountLocalKey(storageRegistry.listingAuthorizations.key)

function authorization(over: Partial<MarketListingAuthorization> = {}): MarketListingAuthorization {
  return {
    key: `${listingTxid}_0:nonce`,
    outpoint: `${listingTxid}_0`,
    nonce: 'nonce',
    seller: identityKey,
    origin: 'b'.repeat(64) + '_0',
    provenanceHash: 'c'.repeat(64),
    priceSats: 1000,
    state: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    listing: {
      outpoint: `${listingTxid}_0`,
      offerOutpoint: `${listingTxid}_1`,
      assetType: 'ordinal',
    } as MarketListingAuthorization['listing'],
    sellerKeys: { listing: listingRemittance, payout },
    ...over,
  }
}

function settlementPaying(address: string, spendsListing: boolean): { txid: string; atomic: number[] } {
  const tx = new Transaction()
  const source = spendsListing ? listingTxid : 'd'.repeat(64)
  tx.addInput({ sourceTXID: source, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  tx.addInput({ sourceTXID: source, sourceOutputIndex: 1, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1 })
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 991 })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  return { txid, atomic: beef.toBinaryAtomic(txid) }
}

function activeWallet(offers: Array<{ outpoint: string; customInstructions: string }> = []) {
  const internalizeAction = vi.fn(async () => ({ accepted: true }))
  const relinquishOutput = vi.fn(async () => ({ relinquished: true }))
  return {
    active: {
      rootKeyHex: root.toHex(),
      identityKey,
      chain: 'main',
      wallet: { internalizeAction, relinquishOutput, listOutputs: vi.fn(async () => ({ outputs: offers })) },
    } as unknown as ActiveWallet,
    internalizeAction,
    relinquishOutput,
  }
}

afterEach(() => {
  durableRemoveItem(storageKey())
  unspent.utxos = []
  beefs.clear()
})

describe('payoutMayHoldUnreceiptedSale', () => {
  const now = Date.now()
  it('watches open v2 listings until their proceeds are filed', () => {
    expect(payoutMayHoldUnreceiptedSale(authorization(), now)).toBe(true)
    expect(payoutMayHoldUnreceiptedSale(authorization({ state: 'settled' }), now)).toBe(true)
    expect(payoutMayHoldUnreceiptedSale(authorization({ proceedsInternalized: true }), now)).toBe(false)
    expect(payoutMayHoldUnreceiptedSale(authorization({ sellerKeys: undefined }), now)).toBe(false)
  })

  it('watches a cancelled listing for a week, since the cancel may have lost the race', () => {
    expect(payoutMayHoldUnreceiptedSale(authorization({ state: 'cancelled', updatedAt: now - 60_000 }), now)).toBe(true)
    expect(
      payoutMayHoldUnreceiptedSale(authorization({ state: 'cancelled', updatedAt: now - 8 * 24 * 60 * 60_000 }), now),
    ).toBe(false)
  })
})

describe('collectUnreceiptedMarketProceeds', () => {
  it('files a sale on the payout child with its remittance and settles the listing, without a receipt', async () => {
    durableSetItem(storageKey(), JSON.stringify([authorization()]))
    const address = brc29PrivateKey(root, payout).toAddress()
    const sale = settlementPaying(address, true)
    unspent.utxos = [{ outpoint: `${sale.txid}_1`, txid: sale.txid, vout: 1, satoshis: 991 }]
    beefs.set(sale.txid, sale.atomic)
    const { active, internalizeAction } = activeWallet()

    expect(await collectUnreceiptedMarketProceeds(active, 1_000_000_000)).toBe(1)
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: sale.atomic,
        outputs: [{ outputIndex: 1, protocol: 'wallet payment', paymentRemittance: payout }],
      }),
    )
    const after = getMarketListingAuthorization({ outpoint: `${listingTxid}_0`, nonce: 'nonce' })
    expect(after).toMatchObject({ state: 'settled', settlementTxid: sale.txid, proceedsInternalized: true, itemRetired: true })
  })

  it('files a stray coin on the payout child but leaves the listing open', async () => {
    durableSetItem(storageKey(), JSON.stringify([authorization()]))
    const stray = settlementPaying(brc29PrivateKey(root, payout).toAddress(), false)
    unspent.utxos = [{ outpoint: `${stray.txid}_1`, txid: stray.txid, vout: 1, satoshis: 991 }]
    beefs.set(stray.txid, stray.atomic)
    const { active, internalizeAction } = activeWallet()

    expect(await collectUnreceiptedMarketProceeds(active, 2_000_000_000)).toBe(1)
    expect(internalizeAction).toHaveBeenCalledOnce()
    expect(getMarketListingAuthorization({ outpoint: `${listingTxid}_0`, nonce: 'nonce' })?.state).toBe('active')
  })

  it('after a restore with no authorization, watches the payout named on the offer output', async () => {
    const sale = settlementPaying(brc29PrivateKey(root, payout).toAddress(), true)
    unspent.utxos = [{ outpoint: `${sale.txid}_1`, txid: sale.txid, vout: 1, satoshis: 991 }]
    beefs.set(sale.txid, sale.atomic)
    const { active, internalizeAction, relinquishOutput } = activeWallet([
      {
        outpoint: `${listingTxid}.1`,
        customInstructions: JSON.stringify({ fields: [], sellerKeys: { listing: listingRemittance, payout } }),
      },
    ])

    expect(await collectUnreceiptedMarketProceeds(active, 3_000_000_000)).toBe(1)
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({ outputs: [{ outputIndex: 1, protocol: 'wallet payment', paymentRemittance: payout }] }),
    )
    expect(relinquishOutput).toHaveBeenCalledWith({ basket: 'market-offers', output: `${listingTxid}.1` })
  })
})
