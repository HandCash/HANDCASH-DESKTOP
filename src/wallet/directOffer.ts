import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { createActor } from 'xstate'
import { mayAbortOffer, offerMachine } from '../machines/offerMachine'
import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { getActiveWallet, bumpBalanceAfterHeal, type ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'
import { signTipInputs } from './signTipInputs'
import {
  getBeefForTxidCached,
  mergeLocalUnconfirmedAncestry,
  rememberBeefTree,
} from './beefCache'
import { describeInsufficientFunds, isInsufficientFundsError } from './insufficientFunds'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN, type ActivityItem } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  buildBsv21SendRemittance,
  buildBsv21ValueLock,
  decodeBsv21Binary,
  planBsv21Send,
} from './token'
import { normalizeTokenId } from './token/types'
import type { Bsv21BinaryLayout } from './token/decode162'
import { sellerUnlockValid, signSellerInputs } from './offerSeal'
import type { OfferWant } from './offerTerms'
import {
  chooseDirectOfferBuyPath,
  chooseDirectOfferCancelPath,
  chooseDirectOfferCollectPath,
  chooseDirectOfferListPath,
  DIRECT_OFFER_BASKET,
  DIRECT_OFFER_BUYER_VOUT,
  DIRECT_OFFER_LEGACY_BASKET,
  DIRECT_OFFER_LOT_VIN,
  DIRECT_OFFER_PRICE_VOUT,
  DIRECT_OFFER_PROTOCOL,
  DIRECT_OFFER_VERSION,
  DirectOfferError,
  parseDirectOffer,
  type DirectOffer,
  type DirectOfferRefuse,
  type DirectOfferState,
} from './directOfferPath'
import { chooseMarketCancelReturn } from './marketListingPath'
import { rememberTipKey, selfTokenOutput, tipSigningKey } from './token/tipKeys'
import { selfBrc29Output, type Remittance } from './brc29Keys'
import type { CountersignedScheme } from './itemAccess'
import type { HolderRemittance } from './countersign/holderKeys'
import { holderSignatureValid, readCountersigned, sameKeySets, SWAP_HOLDER_SCOPE } from './countersign/script'

export type DirectOfferRecord = {
  offer: DirectOffer
  role: 'seller' | 'buyer'
  state: DirectOfferState
  soldTxid?: string
  collectTxid?: string
  cancelTxid?: string
  /** Seller: the BRC-29 child `offer.payTo` names. Absent on offers that paid the identity address. */
  payToRemittance?: Remittance
  /** Basket holding the listed lot; absent means {@link DIRECT_OFFER_BASKET}. A countersigned lot stays in its csft / csnft basket. */
  basket?: typeof DIRECT_OFFER_LEGACY_BASKET | CountersignedScheme
  updatedAt: number
}

const OFFER_LABEL = 'direct-offer'

function offersStorageKey(): string {
  return accountLocalKey(storageRegistry.directOffers.key)
}

/** A 1.3.573 token-swap record, read once so an open lot stays cancellable. */
function fromLegacyRecord(raw: unknown): DirectOfferRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const o = (r.offer ?? {}) as Record<string, unknown>
  const offer = parseDirectOffer({
    ...o,
    protocol: DIRECT_OFFER_PROTOCOL,
    v: DIRECT_OFFER_VERSION,
    seller: o.maker,
    sellerUnlockingScript: o.makerUnlockingScript,
  })
  if (!offer) return null
  const state = (
    { open: 'listed', taken: 'sold', claimed: 'collected', cancelled: 'cancelled' } as const
  )[String(r.state) as 'open' | 'taken' | 'claimed' | 'cancelled']
  if (!state) return null
  return {
    offer,
    role: r.role === 'taker' ? 'buyer' : 'seller',
    state,
    ...(typeof r.takeTxid === 'string' ? { soldTxid: r.takeTxid } : {}),
    ...(typeof r.claimTxid === 'string' ? { collectTxid: r.claimTxid } : {}),
    ...(typeof r.cancelTxid === 'string' ? { cancelTxid: r.cancelTxid } : {}),
    basket: DIRECT_OFFER_LEGACY_BASKET,
    updatedAt: Number(r.updatedAt) || 0,
  }
}

function parseList(text: string | null): unknown[] {
  try {
    const parsed = JSON.parse(text ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readRecords(): DirectOfferRecord[] {
  const current = durableGetItem(offersStorageKey())
  if (current != null) return parseList(current) as DirectOfferRecord[]
  const legacy = parseList(durableGetItem(accountLocalKey(storageRegistry.directOffersLegacy.key)))
    .map(fromLegacyRecord)
    .filter((record): record is DirectOfferRecord => record != null)
  if (legacy.length > 0) durableSetItem(offersStorageKey(), JSON.stringify(legacy))
  return legacy
}

function saveRecord(record: DirectOfferRecord): void {
  const rest = readRecords().filter(
    (r) => !(r.offer.offerId === record.offer.offerId && r.role === record.role),
  )
  durableSetItem(offersStorageKey(), JSON.stringify([...rest, { ...record, updatedAt: Date.now() }]))
}

function findRecord(offerId: string, role: DirectOfferRecord['role']): DirectOfferRecord | null {
  const id = offerId.trim().toLowerCase().replace('_', '.')
  return readRecords().find((r) => r.offer.offerId === id && r.role === role) ?? null
}

export function listDirectOffers(): { offers: DirectOfferRecord[] } {
  return { offers: readRecords().sort((a, b) => b.updatedAt - a.updatedAt) }
}

function requireActive(): ActiveWallet {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  return active
}

function failRefused(path: DirectOfferRefuse): never {
  console.warn(`[direct-offer] refuse ${path.reason}`)
  throw new DirectOfferError(path.reason, path.message)
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } {
  const [txid, vout] = outpoint.trim().toLowerCase().replace('_', '.').split('.')
  return { txid: txid!, vout: Number(vout) }
}

/** Output 0 exactly as the seller signed it. */
export function directOfferPriceOutput(offer: Pick<DirectOffer, 'want' | 'payTo'>): {
  lockingScript: string
  satoshis: number
} {
  if (offer.want.kind === 'sats') {
    return { lockingScript: new P2PKH().lock(offer.payTo).toHex(), satoshis: offer.want.sats }
  }
  return {
    lockingScript: buildBsv21ValueLock({
      tokenId: offer.want.tokenId,
      amount: BigInt(offer.want.amount),
      address: offer.payTo,
      layout: offer.want.layout,
    }),
    satoshis: 1,
  }
}

/** The seller's SINGLE|ANYONECANPAY signature over input 0 → output 0. */
export async function signDirectOfferLot(args: {
  listingTx: Transaction
  lotVout: number
  want: OfferWant
  payTo: string
  privateKey: PrivateKey
}): Promise<string> {
  const source = args.listingTx.outputs[args.lotVout]
  if (!source?.lockingScript) throw new Error('Listed lot output is missing')
  const unlocks = await signSellerInputs({
    privateKey: args.privateKey,
    inputs: [
      {
        vin: DIRECT_OFFER_LOT_VIN,
        sourceTXID: String(args.listingTx.id('hex')),
        sourceOutputIndex: args.lotVout,
        sourceTransaction: args.listingTx,
        sourceSatoshis: source.satoshis ?? 1,
        lockingScript: source.lockingScript.toHex(),
        bound: directOfferPriceOutput({ want: args.want, payTo: args.payTo }),
      },
    ],
  })
  return unlocks[DIRECT_OFFER_LOT_VIN]!
}

async function tipsForToken(active: ActiveWallet, tokenId: string) {
  const { listBsv21BinaryTipsForToken } = await import('./token/listTips')
  const listed = await listBsv21BinaryTipsForToken(active, tokenId, {
    includeCustomInstructions: false,
    inSpend: true,
  })
  return listed.flatMap((t) => {
    const decoded = t.lockingScript ? decodeBsv21Binary(t.lockingScript) : null
    if (!decoded || decoded.role !== 'value' || t.tokenId !== tokenId) return []
    return [
      {
        outpoint: t.outpoint.replace('.', '_'),
        tokenId: t.tokenId,
        amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
        lockingScript: t.lockingScript,
        sym: t.sym,
        dec: t.dec,
        icon: t.icon,
        cosigned: Boolean(t.cosign),
      },
    ]
  })
}

async function plainValueTips(tips: ReadonlyArray<{ lockingScript?: string }>): Promise<boolean> {
  const { chooseBsv21ValueTipPath } = await import('./token/send')
  return chooseBsv21ValueTipPath(tips).path === 'plain'
}

/** The listed lot as an Activity subject, the same way a market listing row carries its asset. */
function listedLotItem(offer: DirectOffer): ActivityItem {
  return {
    name: offer.give.sym ?? 'Token',
    origin: offer.give.tokenId,
    outpoint: offer.offerId,
    tokenId: offer.give.tokenId,
    amt: offer.give.amount,
    dec: offer.give.dec,
    ...(offer.give.icon ? { icon: offer.give.icon } : {}),
  }
}

function describeWant(want: OfferWant): string {
  return want.kind === 'sats'
    ? `${want.sats.toLocaleString()} sats`
    : `${want.amount} ${want.sym ?? 'tokens'}`
}

type OfferChart = { send: (event: { type: 'STAGED'; reference: string } | { type: 'SIGNED_UNKNOWN' } | { type: 'BROADCASTED'; txid: string } | { type: 'COMMITTED' }) => void }

/**
 * List a countersigned lot: a funded trade the issuer countersigns moves the
 * exact units to output 0 under a fresh holder key (tagged held, so transfers
 * never select it), then that key signs the offer's holder half.
 */
async function listCountersignedLot(
  active: ActiveWallet,
  path: Extract<ReturnType<typeof chooseDirectOfferListPath>, { path: 'list' }>,
  scheme: CountersignedScheme,
  chart: OfferChart,
): Promise<DirectOffer> {
  const cs = await import('./countersign/wallet')
  const deploy = await cs.countersignedDeploy(active, path.tokenId)
  if (!deploy) throw new DirectOfferError('invalid-offer', 'This countersigned asset has no readable deploy.')
  if (deploy.kind === 'item' && path.amount !== 1n) {
    throw new DirectOfferError('bad-amount', 'A countersigned item is offered whole.')
  }
  const holdings = (await cs.listCountersignedHoldings(active, path.tokenId)).sort((a, b) =>
    b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
  )
  const covers: typeof holdings = []
  let covered = 0n
  for (const holding of holdings) {
    if (covered >= path.amount) break
    covers.push(holding)
    covered += holding.amount
  }
  if (covered < path.amount) {
    throw new DirectOfferError('INSUFFICIENT_FUNDS', 'Not enough units of this asset are held to offer that amount.')
  }
  const self = active.identityKey.toLowerCase()
  const trade = await cs.runFundedCountersignedTrade({
    assetId: path.tokenId,
    holdings: covers,
    outputs: [
      { kind: 'asset', amount: path.amount, identityKey: self, tags: [cs.MARKET_HELD_TAG] },
      ...(covered > path.amount ? [{ kind: 'asset' as const, amount: covered - path.amount, identityKey: self }] : []),
    ],
    description: 'direct offer list',
    flow: 'direct_offer',
    progress: {
      staged: (reference) => chart.send({ type: 'STAGED', reference }),
      countersigned: () => chart.send({ type: 'SIGNED_UNKNOWN' }),
      broadcast: (txid) => chart.send({ type: 'BROADCASTED', txid }),
    },
  })
  const proceeds = selfBrc29Output(active)
  const sellerUnlockingScript = await signDirectOfferLot({
    listingTx: trade.tx,
    lotVout: 0,
    want: path.want,
    payTo: proceeds.address,
    privateKey: cs.tradeHolderKey(active, path.tokenId, trade.remittance, 0),
  })
  const sym = (deploy.kind === 'item' ? deploy.fields.name : deploy.fields.sym) || deploy.fields.name
  const offer: DirectOffer = {
    protocol: DIRECT_OFFER_PROTOCOL,
    v: DIRECT_OFFER_VERSION,
    offerId: `${trade.txid}.0`,
    seller: self,
    payTo: proceeds.address,
    give: {
      tokenId: path.tokenId,
      amount: path.amount.toString(),
      dec: deploy.fields.dec ?? 0,
      ...(sym ? { sym } : {}),
      lockingScript: trade.tx.outputs[0]!.lockingScript!.toHex(),
    },
    want: path.want,
    sellerUnlockingScript,
    beefB64: Utils.toBase64(trade.atomic),
    createdAt: Date.now(),
  }
  saveRecord({ offer, role: 'seller', state: 'listed', basket: scheme, payToRemittance: proceeds.remittance, updatedAt: Date.now() })
  chart.send({ type: 'COMMITTED' })
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'direct-offer-list',
    note: `Listed ${offer.give.amount} ${offer.give.sym ?? 'tokens'} for ${describeWant(offer.want)} (direct offer)`,
    txid: trade.txid,
    item: listedLotItem(offer),
  })
  scheduleHistoryBackupPush('direct-offer')
  return offer
}

/**
 * List an exact lot of `give` at this wallet's address and sign the offer.
 * The lot leaves the token balance (basket {@link DIRECT_OFFER_BASKET}) until
 * it is bought or cancelled.
 */
export async function createDirectOffer(args: {
  give?: { tokenId?: string; amount?: string | number }
  want?: unknown
}): Promise<{ offer: DirectOffer }> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const tokenId = normalizeTokenId(String(args.give?.tokenId ?? ''))
    const phase = (name: string, since: number) => {
      const ms = Date.now() - since
      if (ms >= 250) console.info(`[direct-offer] ${name} done ${ms}ms`)
    }
    const tipsAt = Date.now()
    const tips = tokenId ? await tipsForToken(active, tokenId) : []
    phase('tips', tipsAt)
    let plan: ReturnType<typeof planBsv21Send> | null = null
    try {
      if (tokenId && /^\d+$/.test(String(args.give?.amount ?? ''))) {
        plan = planBsv21Send({ tokenId, tips, amount: BigInt(String(args.give!.amount)) })
      }
    } catch (err) {
      throw new DirectOfferError('bad-amount', err instanceof Error ? err.message : String(err))
    }
    const selected = plan?.selected ?? []
    const pathAt = Date.now()
    const cosigned =
      selected.length > 0 &&
      (tips.some((t) => t.cosigned && selected.some((s) => s.outpoint === t.outpoint)) ||
        !(await plainValueTips(selected)))
    const { countersignedProfileOf, knownCountersignedProfile } = await import('./countersign/wallet')
    const wantTokenId = normalizeTokenId(String((args.want as { tokenId?: unknown } | null)?.tokenId ?? ''))
    const giveScheme =
      tokenId && tips.length === 0 ? await countersignedProfileOf(active, tokenId).catch(() => null) : null
    const path = chooseDirectOfferListPath({
      tokenId,
      amount: args.give?.amount,
      want: args.want,
      cosigned,
      countersignedGive: giveScheme != null,
      countersignedWant: Boolean(wantTokenId && knownCountersignedProfile(wantTokenId)),
    })
    phase('path', pathAt)
    const chart = createActor(offerMachine).start()
    chart.send({ type: 'LIST', venue: 'direct', path })
    try {
      if (path.path === 'refuse') failRefused(path)
      if (path.lot === 'countersigned') {
        const offer = await listCountersignedLot(active, path, giveScheme!, chart)
        const ms = Date.now() - startedAt
        if (ms >= 250) console.info(`[direct-offer] list done ${ms}ms`)
        return { offer }
      }
      const meta = tips.find((t) => t.sym) ?? tips[0]
      const { splitBsv21CoverToExactAmt } = await import('./marketListing')
      const splitAt = Date.now()
      const lot = await splitBsv21CoverToExactAmt({
        active,
        origin: path.tokenId,
        requested: path.amount,
        covers: selected,
        ...(meta?.icon ? { icon: meta.icon } : {}),
        ...(meta?.sym ? { sym: meta.sym } : {}),
        purpose: 'direct-offer',
        onStaged: (reference) => chart.send({ type: 'STAGED', reference }),
        onSigned: () => chart.send({ type: 'SIGNED_UNKNOWN' }),
      })
      phase('split', splitAt)
      const { txid, vout } = splitOutpoint(lot.outpoint)
      chart.send({ type: 'BROADCASTED', txid })
      const listingTx = lot.beef.findTxid(txid)?.tx
      if (!listingTx) throw new Error('Listing transaction missing from its BEEF')
      const proceeds = selfBrc29Output(active)
      const sellerUnlockingScript = await signDirectOfferLot({
        listingTx,
        lotVout: vout,
        want: path.want,
        payTo: proceeds.address,
        privateKey: await tipSigningKey(active, lot.lockingScript),
      })
      const ancestryAt = Date.now()
      const beef = await mergeLocalUnconfirmedAncestry(
        active,
        Array.from(lot.beef.toBinaryAtomic(txid)),
      )
      phase('ancestry', ancestryAt)
      const offer: DirectOffer = {
        protocol: DIRECT_OFFER_PROTOCOL,
        v: DIRECT_OFFER_VERSION,
        offerId: `${txid}.${vout}`,
        seller: active.identityKey.toLowerCase(),
        payTo: proceeds.address,
        give: {
          tokenId: path.tokenId,
          amount: path.amount.toString(),
          dec: meta?.dec ?? 0,
          ...(meta?.sym ? { sym: meta.sym } : {}),
          ...(meta?.icon ? { icon: meta.icon } : {}),
          lockingScript: lot.lockingScript,
        },
        want: path.want,
        sellerUnlockingScript,
        beefB64: Utils.toBase64(beef),
        createdAt: Date.now(),
      }
      saveRecord({ offer, role: 'seller', state: 'listed', payToRemittance: proceeds.remittance, updatedAt: Date.now() })
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'direct-offer-list',
        note: `Listed ${offer.give.amount} ${offer.give.sym ?? 'tokens'} for ${describeWant(offer.want)} (direct offer)`,
        txid,
        item: listedLotItem(offer),
      })
      scheduleHistoryBackupPush('direct-offer')
      const ms = Date.now() - startedAt
      if (ms >= 250) console.info(`[direct-offer] list done ${ms}ms`)
      return { offer }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

/**
 * Have the issuer countersign a purchase of a countersigned lot. Input 0
 * carries the seller's holder half (SINGLE|ANYONECANPAY over output 0);
 * toolbox funding is unsigned yet and travels with empty scripts, which the
 * issuer's ALL countersignature never covers.
 */
async function countersignPurchase(args: {
  beef: Beef
  txid: string
  sellerHalf: string
  holderPkhHex: string
  coverSpends: Record<number, { unlockingScript: string }>
  assetId: string
  remittance: HolderRemittance
}): Promise<string> {
  const tx = args.beef.findTransactionForSigning(args.txid)
  if (!tx) throw new Error('Purchase transaction is missing from its signable package')
  tx.inputs.forEach((input, vin) => {
    if (!input.sourceTransaction) throw new Error(`Purchase input ${vin} has no source`)
    const own = vin === DIRECT_OFFER_LOT_VIN ? args.sellerHalf : args.coverSpends[vin]?.unlockingScript
    input.unlockingScript = own ? UnlockingScript.fromHex(own) : new UnlockingScript()
  })
  const bound = tx.outputs[DIRECT_OFFER_PRICE_VOUT]?.lockingScript
  if (
    !holderSignatureValid(tx, DIRECT_OFFER_LOT_VIN, args.holderPkhHex, [SWAP_HOLDER_SCOPE]) ||
    !bound ||
    readCountersigned(bound)
  ) {
    failRefused({
      path: 'refuse',
      reason: 'unbound-signature',
      message: 'The seller signature does not unlock this purchase. Nothing was spent.',
    })
  }
  const { countersignTrade } = await import('./countersign/wallet')
  const trade = await countersignTrade({ tx, assetId: args.assetId, remittance: args.remittance })
  return trade.unlocks[DIRECT_OFFER_LOT_VIN]!.toHex()
}

/**
 * Buy a direct offer: pay output 0 exactly, take the listed lot. Input 0 is
 * the seller's signed lot; the buyer's want-token covers and the toolbox
 * funding follow.
 */
export async function buyDirectOffer(args: { offer?: unknown }): Promise<{
  offerId: string
  txid: string
  settle: 'selfCollect' | 'peerCollect'
}> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const mark = (phase: string) => console.info(`[direct-offer] +${Date.now() - startedAt}ms ${phase}`)
    const active = requireActive()
    const path = chooseDirectOfferBuyPath({ offer: args.offer, buyerIdentityKey: active.identityKey })
    const chart = createActor(offerMachine).start()
    chart.send({ type: 'BUY', venue: 'direct', path })
    let reference: string | null = null
    try {
      if (path.path === 'refuse') failRefused(path)
      const { offer, settle } = path
      const lotPoint = splitOutpoint(offer.offerId)
      const offerBeef = Beef.fromBinary(Utils.toArray(offer.beefB64, 'base64'))
      const lotSource = offerBeef.findTxid(lotPoint.txid)?.tx?.outputs[lotPoint.vout]
      const lotLock = lotSource?.lockingScript?.toHex().toLowerCase()
      const decodedLot = lotLock ? decodeBsv21Binary(lotLock) : null
      const csLot = lotLock ? readCountersigned(lotLock) : null
      if (!lotSource || lotLock !== offer.give.lockingScript) {
        throw new DirectOfferError('invalid-offer', 'The offer does not carry the token lot it describes.')
      }
      // A countersigned lot needs no lineage walk: the issuer accepts only
      // outputs it countersigned, and countersigns this purchase below.
      let receive: ReturnType<typeof import('./countersign/wallet').planCountersignedReceive> | null = null
      let lotUnlockLength = 108
      if (csLot) {
        const cs = await import('./countersign/wallet')
        const deploy = await cs.countersignedDeploy(active, offer.give.tokenId)
        if (
          !deploy ||
          lotSource.satoshis !== 1 ||
          csLot.assetId !== offer.give.tokenId ||
          csLot.amount !== BigInt(offer.give.amount) ||
          !sameKeySets(csLot.sets, deploy.sets)
        ) {
          throw new DirectOfferError('invalid-offer', 'The offer does not carry the countersigned lot it describes.')
        }
        receive = cs.planCountersignedReceive(active, deploy, DIRECT_OFFER_BUYER_VOUT, csLot.amount)
        lotUnlockLength = 112 + 74 * Math.max(deploy.sets.issuer.threshold, deploy.sets.release.threshold)
        mark('countersigned lot checked')
      } else {
        if (
          !decodedLot ||
          decodedLot.role !== 'value' ||
          decodedLot.tokenId !== offer.give.tokenId ||
          decodedLot.amount !== BigInt(offer.give.amount)
        ) {
          throw new DirectOfferError('invalid-offer', 'The offer does not carry the token lot it describes.')
        }
        if (!(await plainValueTips([{ lockingScript: lotLock }]))) {
          failRefused({ path: 'refuse', reason: 'cosigned-token', message: 'Issuer-cosigned tokens cannot be listed.' })
        }
        const { proveTokenTipLineage } = await import('./token/proveTipLineage')
        const lineage = await proveTokenTipLineage(active, offer.offerId, offerBeef.toBinary())
        if (!lineage.ok || lineage.tokenId !== offer.give.tokenId) {
          throw new DirectOfferError(
            'DIRECT_OFFER_UNPROVEN',
            `The offered token's history could not be proven back to its deploy${lineage.ok ? '' : ` (${lineage.reason})`}. Nothing was spent.`,
          )
        }
        mark('lot lineage proven')
      }

      let covers: Array<{ outpoint: string; amt: bigint; lockingScript?: string }> = []
      let wantChange = 0n
      let wantLayout: Bsv21BinaryLayout | null = null
      if (offer.want.kind === 'token') {
        const tips = await tipsForToken(active, offer.want.tokenId)
        let plan: ReturnType<typeof planBsv21Send>
        try {
          plan = planBsv21Send({ tokenId: offer.want.tokenId, tips, amount: BigInt(offer.want.amount) })
        } catch (err) {
          throw new DirectOfferError('INSUFFICIENT_FUNDS', err instanceof Error ? err.message : String(err))
        }
        if (plan.layout !== offer.want.layout) {
          failRefused({
            path: 'refuse',
            reason: 'want-layout-mismatch',
            message: 'Your tokens use a different token format from the one this offer asks for.',
          })
        }
        if (!(await plainValueTips(plan.selected))) {
          failRefused({ path: 'refuse', reason: 'cosigned-token', message: 'Issuer-cosigned tokens cannot be listed.' })
        }
        covers = plan.selected
        wantChange = plan.changeAmt
        wantLayout = plan.layout
      }

      const inputBeef = offerBeef.clone()
      for (const txid of new Set(covers.map((c) => splitOutpoint(c.outpoint).txid))) {
        try {
          inputBeef.mergeBeef(
            (await getBeefForTxidCached(active, txid, { needProof: true, allowUnprovenRawTx: true })).toBinary(),
          )
        } catch {
          // Storage holds our own covers; trustSelf 'known' reads them there.
        }
      }
      inputBeef.atomicTxid = undefined

      const price = directOfferPriceOutput(offer)
      const lotKey = receive ? null : selfTokenOutput(active)
      const wantChangeKey =
        offer.want.kind === 'token' && wantChange > 0n && wantLayout
          ? selfTokenOutput(active, lotKey?.remittance.derivationPrefix)
          : null
      const priceRemittance =
        settle === 'selfCollect' && offer.want.kind === 'token'
          ? buildBsv21SendRemittance({
              tokenId: offer.want.tokenId,
              amt: BigInt(offer.want.amount),
              ...(offer.want.sym ? { sym: offer.want.sym } : {}),
            })
          : {}
      const outputs = [
        { ...price, outputDescription: 'Direct offer payment to seller', ...priceRemittance },
        receive
          ? {
              lockingScript: receive.lockingScript,
              satoshis: 1,
              outputDescription: 'Purchased token to buyer',
              basket: receive.basket,
              tags: receive.tags,
              customInstructions: receive.customInstructions,
            }
          : {
              lockingScript: buildBsv21ValueLock({
                tokenId: offer.give.tokenId,
                amount: BigInt(offer.give.amount),
                address: lotKey!.address,
                layout: decodedLot!.layout,
              }),
              satoshis: 1,
              outputDescription: 'Purchased token to buyer',
              ...buildBsv21SendRemittance({
                tokenId: offer.give.tokenId,
                amt: BigInt(offer.give.amount),
                ...(offer.give.sym ? { sym: offer.give.sym } : {}),
                ...(offer.give.icon ? { icon: offer.give.icon } : {}),
                remittance: lotKey!.remittance,
              }),
            },
        ...(offer.want.kind === 'token' && wantChangeKey && wantLayout
          ? [
              {
                lockingScript: buildBsv21ValueLock({
                  tokenId: offer.want.tokenId,
                  amount: wantChange,
                  address: wantChangeKey.address,
                  layout: wantLayout,
                }),
                satoshis: 1,
                outputDescription: 'Direct offer token change',
                ...buildBsv21SendRemittance({
                  tokenId: offer.want.tokenId,
                  amt: wantChange,
                  ...(offer.want.sym ? { sym: offer.want.sym } : {}),
                  remittance: wantChangeKey.remittance,
                }),
              },
            ]
          : []),
      ]
      if (lotKey) rememberTipKey(active, lotKey.key)
      if (wantChangeKey) rememberTipKey(active, wantChangeKey.key)
      let created: Awaited<ReturnType<typeof active.wallet.createAction>>
      try {
        created = await active.wallet.createAction({
          description: `Buy ${offer.give.amount} ${offer.give.sym ?? 'tokens'} (direct offer)`,
          labels: [OFFER_LABEL, `direct-offer:${offer.offerId}`],
          inputBEEF: inputBeef.toBinary(),
          inputs: [
            { outpoint: offer.offerId, inputDescription: 'Direct offer lot', unlockingScriptLength: lotUnlockLength },
            ...covers.map((c) => ({
              outpoint: c.outpoint.replace('_', '.'),
              inputDescription: 'Direct offer payment token',
              unlockingScriptLength: 108,
            })),
          ],
          outputs,
          options: {
            randomizeOutputs: false,
            signAndProcess: false,
            noSend: true,
            trustSelf: 'known',
          },
        })
      } catch (err) {
        if (isInsufficientFundsError(err) && offer.want.kind === 'sats') {
          throw new DirectOfferError(
            'INSUFFICIENT_FUNDS',
            await describeInsufficientFunds(active.wallet, offer.want.sats + 100),
          )
        }
        throw err
      }
      const signable = created.signableTransaction
      if (!signable) throw new Error('Direct offer purchase did not return a signable transaction')
      reference = signable.reference
      chart.send({ type: 'STAGED', reference })
      const signableBeef = Beef.fromBinary(signable.tx)
      const tx = signableBeef.txs
        .map((entry) => entry.tx)
        .find((candidate) =>
          candidate?.inputs.some(
            (input) =>
              String(input.sourceTXID).toLowerCase() === lotPoint.txid &&
              input.sourceOutputIndex === lotPoint.vout,
          ),
        )
      const lotIn = tx?.inputs[DIRECT_OFFER_LOT_VIN]
      if (
        !tx ||
        String(lotIn?.sourceTXID).toLowerCase() !== lotPoint.txid ||
        lotIn?.sourceOutputIndex !== lotPoint.vout ||
        tx.outputs[DIRECT_OFFER_PRICE_VOUT]?.lockingScript?.toHex() !== price.lockingScript ||
        tx.outputs[DIRECT_OFFER_PRICE_VOUT]?.satoshis !== price.satoshis ||
        tx.outputs[DIRECT_OFFER_BUYER_VOUT]?.lockingScript?.toHex() !== outputs[1]!.lockingScript
      ) {
        throw new DirectOfferError(
          'DIRECT_OFFER_SHAPE_MISMATCH',
          'The wallet did not keep the offer inputs and outputs in order. Nothing was spent.',
        )
      }
      if (
        !receive &&
        !sellerUnlockValid({
          tx,
          vin: DIRECT_OFFER_LOT_VIN,
          sourceSatoshis: lotSource.satoshis ?? 1,
          lockingScript: lotLock,
          unlockingScript: offer.sellerUnlockingScript,
        })
      ) {
        failRefused({
          path: 'refuse',
          reason: 'unbound-signature',
          message: 'The seller signature does not unlock this purchase. Nothing was spent.',
        })
      }
      tx.inputs[DIRECT_OFFER_LOT_VIN]!.unlockingScript = UnlockingScript.fromHex(offer.sellerUnlockingScript)
      const coverKeys = await Promise.all(
        covers.map((cover) => (cover.lockingScript ? tipSigningKey(active, cover.lockingScript) : null)),
      )
      const coverVins = covers.map((cover, i) => {
        const { txid, vout } = splitOutpoint(cover.outpoint)
        const vin = tx.inputs.findIndex(
          (input) => String(input.sourceTXID).toLowerCase() === txid && input.sourceOutputIndex === vout,
        )
        if (vin < 0 || !cover.lockingScript) {
          throw new DirectOfferError('DIRECT_OFFER_SHAPE_MISMATCH', 'A payment token input is missing.')
        }
        tx.inputs[vin]!.unlockingScriptTemplate = new P2PKH().unlock(
          coverKeys[i]!,
          'all',
          false,
          1,
          LockingScript.fromHex(cover.lockingScript),
        )
        return vin
      })
      const coverSpends = await signTipInputs(tx, coverVins)
      let lotUnlockingScript = offer.sellerUnlockingScript
      if (receive && csLot) {
        lotUnlockingScript = await countersignPurchase({
          beef: signableBeef,
          txid: tx.id('hex'),
          sellerHalf: offer.sellerUnlockingScript,
          holderPkhHex: csLot.holderPkhHex,
          coverSpends,
          assetId: offer.give.tokenId,
          remittance: receive.remittance,
        })
        mark('issuer countersigned the purchase')
      }
      chart.send({ type: 'SIGNED_UNKNOWN' })
      const signed = await active.wallet.signAction({
        reference,
        spends: {
          ...coverSpends,
          [DIRECT_OFFER_LOT_VIN]: { unlockingScript: lotUnlockingScript },
        },
        options: { acceptDelayedBroadcast: true },
      })
      const txid = signed.txid?.toLowerCase() ?? ''
      let atomic = signed.tx ? Array.from(signed.tx) : []
      if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) {
        throw new Error('Signed direct offer purchase missing')
      }
      atomic = await mergeLocalUnconfirmedAncestry(active, atomic)
      rememberBeefTree(atomic, txid)
      const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
      startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'direct_offer' }))
      reference = null
      chart.send({ type: 'BROADCASTED', txid })
      mark(`signed ${txid.slice(0, 12)} — cheque registered, miners in background`)

      saveRecord({ offer, role: 'buyer', state: 'sold', soldTxid: txid, updatedAt: Date.now() })
      const sellerRecord = findRecord(offer.offerId, 'seller')
      if (sellerRecord) {
        const filed = settle === 'selfCollect' && offer.want.kind === 'token'
        saveRecord({
          ...sellerRecord,
          state: filed ? 'collected' : 'sold',
          soldTxid: txid,
          ...(filed ? { collectTxid: txid } : {}),
        })
      }
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: offer.want.kind === 'sats' ? offer.want.sats : 0,
        method: 'direct-offer-buy',
        note: `Bought ${offer.give.amount} ${offer.give.sym ?? 'tokens'} for ${describeWant(offer.want)} (direct offer)`,
        txid,
      })
      void import('./token')
        .then(({ listFungibles }) => listFungibles(active))
        .catch(() => {})
      scheduleHistoryBackupPush('direct-offer')
      // Buying our own sats offer paid output 0 to our own address; sweep it
      // once this spend lease is released.
      if (settle === 'selfCollect' && offer.want.kind === 'sats') {
        setTimeout(() => {
          void collectDirectOfferProceeds({ offerId: offer.offerId, txid }).catch((err) => {
            console.warn('[direct-offer] self collect deferred', err instanceof Error ? err.message : String(err))
          })
        }, 0)
      }
      mark('done')
      return { offerId: offer.offerId, txid, settle }
    } catch (err) {
      if (reference && mayAbortOffer(chart.getSnapshot())) {
        await active.wallet.abortAction({ reference }).catch(() => {})
        chart.send({ type: 'ABORTED', error: err instanceof Error ? err.message : String(err) })
      } else {
        chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      }
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

/**
 * Seller side after a purchase: file output 0 (sweep the sats, or ingest the
 * token), then retire the listed lot. Runs outside the spend lease — the
 * sweep takes it itself.
 */
type CollectResult = { offerId: string; txid: string; proceeds: 'sats' | 'token' }

/** One collect per offer: the self-collect after a buy and an app's own call share it. */
const collecting = new Map<string, Promise<CollectResult>>()

export function collectDirectOfferProceeds(args: { offerId?: string; txid?: string }): Promise<CollectResult> {
  const offerId = String(args.offerId ?? '')
  const record = findRecord(offerId, 'seller')
  const wantTxid = String(args.txid ?? '').trim().toLowerCase()
  if (record?.state === 'collected' && record.collectTxid && (!wantTxid || wantTxid === record.collectTxid)) {
    return Promise.resolve({ offerId: record.offer.offerId, txid: record.collectTxid, proceeds: record.offer.want.kind })
  }
  const inFlight = collecting.get(offerId)
  if (inFlight) return inFlight
  const run = collectOnce(args).finally(() => collecting.delete(offerId))
  collecting.set(offerId, run)
  return run
}

async function collectOnce(args: { offerId?: string; txid?: string }): Promise<CollectResult> {
  const active = requireActive()
  const record = findRecord(String(args.offerId ?? ''), 'seller')
  if (!record) {
    throw new DirectOfferError('not-seller', 'This wallet has no record of listing that offer.')
  }
  const path = chooseDirectOfferCollectPath({
    offer: record.offer,
    state: record.state,
    sellerIdentityKey: active.identityKey,
    txid: args.txid ?? record.soldTxid,
  })
  const chart = createActor(offerMachine).start()
  chart.send({ type: 'COLLECT', venue: 'direct', path })
  try {
    if (path.path === 'refuse') failRefused(path)
    const offer = record.offer
    const lotPoint = splitOutpoint(offer.offerId)
    const beef = await getBeefForTxidCached(active, path.txid, {
      needProof: false,
      allowUnprovenRawTx: true,
    })
    const tx = beef.findTxid(path.txid)?.tx
    const price = directOfferPriceOutput(offer)
    if (
      !tx ||
      String(tx.inputs[DIRECT_OFFER_LOT_VIN]?.sourceTXID).toLowerCase() !== lotPoint.txid ||
      tx.inputs[DIRECT_OFFER_LOT_VIN]?.sourceOutputIndex !== lotPoint.vout ||
      tx.outputs[DIRECT_OFFER_PRICE_VOUT]?.lockingScript?.toHex() !== price.lockingScript ||
      tx.outputs[DIRECT_OFFER_PRICE_VOUT]?.satoshis !== price.satoshis
    ) {
      throw new DirectOfferError('DIRECT_OFFER_SHAPE_MISMATCH', 'That transaction does not buy this offer.')
    }
    const atomic = Array.from(beef.toBinaryAtomic(path.txid))
    const remittance = record.payToRemittance
    if (path.proceeds === 'sats' && remittance) {
      await active.wallet.internalizeAction({
        tx: atomic,
        outputs: [
          {
            outputIndex: DIRECT_OFFER_PRICE_VOUT,
            protocol: 'wallet payment',
            paymentRemittance: remittance,
          },
        ],
        description: 'Direct offer sale proceeds',
        labels: [OFFER_LABEL, `direct-offer:${offer.offerId}`],
      })
      bumpBalanceAfterHeal()
    } else if (path.proceeds === 'sats') {
      const { sweepVisibleP2pkhOutpoints } = await import('./importP2pkhFunding')
      const swept = await sweepVisibleP2pkhOutpoints(active, [`${path.txid}.${DIRECT_OFFER_PRICE_VOUT}`], atomic)
      if (!swept[0]?.success) throw new Error(swept[0]?.error ?? 'Sale proceeds sweep failed')
      bumpBalanceAfterHeal()
    } else if (offer.want.kind === 'token') {
      const { internalizePeerFungibleSettle } = await import('./token')
      const ingested = await internalizePeerFungibleSettle({
        txid: path.txid,
        tx: atomic,
        token: {
          kind: 'fungible',
          tokenId: offer.want.tokenId,
          amount: offer.want.amount,
          sym: offer.want.sym ?? 'Token',
          dec: offer.want.dec ?? 0,
          ...(remittance
            ? {
                remittance: {
                  senderIdentityKey: remittance.senderIdentityKey,
                  outputs: [
                    {
                      vout: DIRECT_OFFER_PRICE_VOUT,
                      derivationPrefix: remittance.derivationPrefix,
                      derivationSuffix: remittance.derivationSuffix,
                    },
                  ],
                },
              }
            : {}),
        },
      })
      if (!ingested.accepted) throw new Error(`Sale token ingest refused (${ingested.reason ?? 'unknown'})`)
    }
    await active.wallet
      .relinquishOutput({ basket: record.basket ?? DIRECT_OFFER_BASKET, output: offer.offerId })
      .catch(() => {})
    const { hideSpentOutpoints } = await import('./staleOutputRelease')
    await hideSpentOutpoints([offer.offerId], path.txid, active).catch(() => 0)
    saveRecord({ ...record, state: 'collected', soldTxid: path.txid, collectTxid: path.txid })
    chart.send({ type: 'COLLECTED' })
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: offer.want.kind === 'sats' ? offer.want.sats : 0,
      method: 'direct-offer-sale',
      note: `Sold ${offer.give.amount} ${offer.give.sym ?? 'tokens'} for ${describeWant(offer.want)} (direct offer)`,
      txid: path.txid,
    })
    scheduleHistoryBackupPush('direct-offer')
    return { offerId: offer.offerId, txid: path.txid, proceeds: path.proceeds }
  } catch (err) {
    chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    chart.stop()
  }
}

/** Spend the listed lot back to this wallet's token balance. */
export async function cancelDirectOffer(args: { offerId?: string }): Promise<{
  offerId: string
  txid: string
}> {
  return runExclusiveSpend(async () => {
    const active = requireActive()
    const record = findRecord(String(args.offerId ?? ''), 'seller')
    if (!record) {
      throw new DirectOfferError('not-seller', 'This wallet has no record of listing that offer.')
    }
    const lotPoint = splitOutpoint(record.offer.offerId)
    const { cloudSpentStatus } = await import('./chainProbeClient')
    const spent = await cloudSpentStatus(lotPoint.txid, lotPoint.vout, active.chain).catch(() => null)
    const path = chooseDirectOfferCancelPath({
      offer: record.offer,
      state: record.state,
      sellerIdentityKey: active.identityKey,
      spent,
    })
    const chart = createActor(offerMachine).start()
    chart.send({ type: 'CANCEL', venue: 'direct', path })
    let reference: string | null = null
    try {
      if (path.path === 'refuse') {
        if (path.reason === 'offer-already-sold') saveRecord({ ...record, state: 'sold' })
        failRefused(path)
      }
      const offer = record.offer
      if (record.basket === 'csft' || record.basket === 'csnft') {
        const cs = await import('./countersign/wallet')
        const source = await cs.countersignedHoldingAt(active, offer.offerId)
        if (!source || source.holding.assetId !== offer.give.tokenId) {
          throw new DirectOfferError('invalid-offer', 'This wallet no longer holds the listed lot. Nothing was spent.')
        }
        const trade = await cs.runFundedCountersignedTrade({
          assetId: offer.give.tokenId,
          holdings: [source.holding],
          outputs: [{ kind: 'asset', amount: source.holding.amount, identityKey: active.identityKey.toLowerCase() }],
          description: 'direct offer cancel',
          flow: 'direct_offer',
          progress: {
            staged: (requestId) => chart.send({ type: 'STAGED', reference: requestId }),
            countersigned: () => chart.send({ type: 'SIGNED_UNKNOWN' }),
            broadcast: (txid) => chart.send({ type: 'BROADCASTED', txid }),
          },
        })
        saveRecord({ ...record, state: 'cancelled', cancelTxid: trade.txid })
        chart.send({ type: 'COMMITTED' })
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'event',
          sats: 0,
          method: 'direct-offer-cancel',
          note: `Cancelled direct offer for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
          txid: trade.txid,
          item: listedLotItem(offer),
        })
        return { offerId: offer.offerId, txid: trade.txid }
      }
      const back = chooseMarketCancelReturn({
        assetType: 'bsv21',
        listedLockHex: offer.give.lockingScript,
        tokenId: offer.give.tokenId,
        amt: offer.give.amount,
      })
      console.info(`[direct-offer] cancel ${offer.offerId.slice(0, 18)}… return=${back.kind}${back.kind === 'refuse' ? ` ${back.reason}` : ''}`)
      if (back.kind !== 'brc162' && back.kind !== 'draft-tagged') {
        throw new DirectOfferError('invalid-offer', 'The listed lot does not hold the token and amount the offer names.')
      }
      const returned = selfTokenOutput(active)
      rememberTipKey(active, returned.key)
      const created = await active.wallet.createAction({
        description: `Cancel direct offer for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
        labels: [OFFER_LABEL, 'direct-offer-cancel', `direct-offer:${offer.offerId}`],
        inputBEEF: Utils.toArray(offer.beefB64, 'base64'),
        inputs: [{ outpoint: offer.offerId, inputDescription: 'Direct offer lot', unlockingScriptLength: 108 }],
        outputs: [
          {
            lockingScript: buildBsv21ValueLock({
              tokenId: back.tokenId,
              amount: back.amount,
              address: returned.address,
              layout: back.kind,
            }),
            satoshis: 1,
            outputDescription: 'Listed lot returned',
            ...buildBsv21SendRemittance({
              tokenId: offer.give.tokenId,
              amt: BigInt(offer.give.amount),
              ...(offer.give.sym ? { sym: offer.give.sym } : {}),
              ...(offer.give.icon ? { icon: offer.give.icon } : {}),
              remittance: returned.remittance,
            }),
          },
        ],
        options: { randomizeOutputs: false, signAndProcess: false, noSend: true, trustSelf: 'known' },
      })
      const signable = created.signableTransaction
      if (!signable) throw new Error('Direct offer cancel did not return a signable transaction')
      reference = signable.reference
      chart.send({ type: 'STAGED', reference })
      const tx = Beef.fromBinary(signable.tx).txs
        .map((entry) => entry.tx)
        .find((candidate) =>
          candidate?.inputs.some(
            (input) =>
              String(input.sourceTXID).toLowerCase() === lotPoint.txid &&
              input.sourceOutputIndex === lotPoint.vout,
          ),
        )
      if (
        !tx ||
        String(tx.inputs[0]?.sourceTXID).toLowerCase() !== lotPoint.txid ||
        tx.inputs[0]?.sourceOutputIndex !== lotPoint.vout
      ) {
        throw new DirectOfferError('DIRECT_OFFER_SHAPE_MISMATCH', 'The wallet did not keep the listed lot first.')
      }
      tx.inputs[0]!.unlockingScriptTemplate = new P2PKH().unlock(
        await tipSigningKey(active, offer.give.lockingScript),
        'all',
        false,
        1,
        LockingScript.fromHex(offer.give.lockingScript),
      )
      const spends = await signTipInputs(tx, [0])
      chart.send({ type: 'SIGNED_UNKNOWN' })
      const signed = await active.wallet.signAction({
        reference,
        spends,
        options: { acceptDelayedBroadcast: true },
      })
      const txid = signed.txid?.toLowerCase() ?? ''
      let atomic = signed.tx ? Array.from(signed.tx) : []
      if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('Signed direct offer cancel missing')
      atomic = await mergeLocalUnconfirmedAncestry(active, atomic)
      rememberBeefTree(atomic, txid)
      const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
      startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'direct_offer' }))
      reference = null
      chart.send({ type: 'BROADCASTED', txid })
      saveRecord({ ...record, state: 'cancelled', cancelTxid: txid })
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'direct-offer-cancel',
        note: `Cancelled direct offer for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
        txid,
        item: listedLotItem(offer),
      })
      void import('./token')
        .then(({ listFungibles }) => listFungibles(active))
        .catch(() => {})
      scheduleHistoryBackupPush('direct-offer')
      return { offerId: offer.offerId, txid }
    } catch (err) {
      if (reference && mayAbortOffer(chart.getSnapshot())) {
        await active.wallet.abortAction({ reference }).catch(() => {})
        chart.send({ type: 'ABORTED', error: err instanceof Error ? err.message : String(err) })
      } else {
        chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      }
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}
