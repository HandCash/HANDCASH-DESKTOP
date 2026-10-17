import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { mayAbortTokenSwap, tokenSwapMachine } from '../machines/tokenSwapMachine'
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
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  buildBsv21SendRemittance,
  buildBsv21ValueLock,
  decodeBsv21Binary,
  planBsv21Send,
} from './token'
import { normalizeTokenId } from './token/types'
import type { Bsv21BinaryLayout } from './token/decode162'
import {
  chooseTokenSwapCancelPath,
  chooseTokenSwapClaimPath,
  chooseTokenSwapMakePath,
  chooseTokenSwapTakePath,
  parseTokenSwapOffer,
  TOKEN_SWAP_BASKET,
  TOKEN_SWAP_GIVE_VIN,
  TOKEN_SWAP_PROTOCOL,
  TOKEN_SWAP_TAKER_VOUT,
  TOKEN_SWAP_VERSION,
  TOKEN_SWAP_WANT_VOUT,
  TokenSwapError,
  type TokenSwapOffer,
  type TokenSwapOfferState,
  type TokenSwapRefuse,
  type TokenSwapWant,
} from './tokenSwapPath'

export type TokenSwapRecord = {
  offer: TokenSwapOffer
  role: 'maker' | 'taker'
  state: TokenSwapOfferState
  takeTxid?: string
  claimTxid?: string
  cancelTxid?: string
  updatedAt: number
}

const OFFERS_KEY = storageRegistry.tokenSwapOffers.key
const SWAP_LABEL = 'token-swap'

function offersStorageKey(): string {
  return accountLocalKey(OFFERS_KEY)
}

function readRecords(): TokenSwapRecord[] {
  try {
    const parsed = JSON.parse(durableGetItem(offersStorageKey()) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as TokenSwapRecord[]) : []
  } catch {
    return []
  }
}

function saveRecord(record: TokenSwapRecord): void {
  const rest = readRecords().filter(
    (r) => !(r.offer.offerId === record.offer.offerId && r.role === record.role),
  )
  durableSetItem(offersStorageKey(), JSON.stringify([...rest, { ...record, updatedAt: Date.now() }]))
}

function findRecord(offerId: string, role: TokenSwapRecord['role']): TokenSwapRecord | null {
  const id = offerId.trim().toLowerCase().replace('_', '.')
  return readRecords().find((r) => r.offer.offerId === id && r.role === role) ?? null
}

export function listTokenSwapOffers(): { offers: TokenSwapRecord[] } {
  return { offers: readRecords().sort((a, b) => b.updatedAt - a.updatedAt) }
}

function requireActive(): ActiveWallet {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  return active
}

function failRefused(path: TokenSwapRefuse): never {
  console.warn(`[token-swap] refuse ${path.reason}`)
  throw new TokenSwapError(path.reason, path.message)
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } {
  const [txid, vout] = outpoint.trim().toLowerCase().replace('_', '.').split('.')
  return { txid: txid!, vout: Number(vout) }
}

/** Output 0 exactly as the maker signed it. */
export function tokenSwapWantOutput(offer: Pick<TokenSwapOffer, 'want' | 'payTo'>): {
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

/**
 * The maker's SIGHASH_SINGLE|ANYONECANPAY signature over input 0 → output 0.
 * Every other input and output is outside the digest, so the skeleton needs
 * only those two.
 */
export async function signTokenSwapMakerInput(args: {
  giveTx: Transaction
  giveVout: number
  want: TokenSwapWant
  payTo: string
  privateKey: PrivateKey
}): Promise<string> {
  const source = args.giveTx.outputs[args.giveVout]
  if (!source?.lockingScript) throw new Error('Swap escrow output is missing')
  const skeleton = new Transaction()
  skeleton.addInput({
    sourceTXID: String(args.giveTx.id('hex')),
    sourceOutputIndex: args.giveVout,
    sourceTransaction: args.giveTx,
    sequence: 0xffffffff,
  })
  const want = tokenSwapWantOutput({ want: args.want, payTo: args.payTo })
  skeleton.addOutput({
    satoshis: want.satoshis,
    lockingScript: LockingScript.fromHex(want.lockingScript),
  })
  const unlocking = await new P2PKH()
    .unlock(args.privateKey, 'single', true, source.satoshis ?? 1, source.lockingScript)
    .sign(skeleton, TOKEN_SWAP_GIVE_VIN)
  return unlocking.toHex()
}

/**
 * Script-check the maker's unlock inside the transaction the taker is about
 * to sign. A signature over a different output 0 — or a different input — is
 * refused here, before any of the taker's coins are signed.
 */
export function tokenSwapMakerUnlockValid(args: {
  tx: Transaction
  giveSatoshis: number
  giveLockingScript: string
  makerUnlockingScript: string
}): boolean {
  const input = args.tx.inputs[TOKEN_SWAP_GIVE_VIN]
  if (!input) return false
  try {
    return new Spend({
      sourceTXID: String(input.sourceTXID),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: args.giveSatoshis,
      lockingScript: LockingScript.fromHex(args.giveLockingScript),
      transactionVersion: args.tx.version,
      otherInputs: [],
      allInputs: args.tx.inputs,
      unlockingScript: UnlockingScript.fromHex(args.makerUnlockingScript),
      inputSequence: input.sequence ?? 0xffffffff,
      inputIndex: TOKEN_SWAP_GIVE_VIN,
      outputs: args.tx.outputs,
      lockTime: args.tx.lockTime,
      isRelaxed: true,
    } as ConstructorParameters<typeof Spend>[0]).validate()
  } catch {
    return false
  }
}

async function tipsForToken(active: ActiveWallet, tokenId: string) {
  const { listBsv21BinaryTipsForToken } = await import('./token/listTips')
  const listed = await listBsv21BinaryTipsForToken(active, tokenId, {
    includeCustomInstructions: false,
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

/**
 * Escrow an exact lot of `give` at this wallet's address and sign the offer.
 * The lot leaves the token balance (basket {@link TOKEN_SWAP_BASKET}) until it
 * is taken or cancelled.
 */
export async function createTokenSwapOffer(args: {
  give?: { tokenId?: string; amount?: string | number }
  want?: unknown
}): Promise<{ offer: TokenSwapOffer }> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const tokenId = normalizeTokenId(String(args.give?.tokenId ?? ''))
    const tips = tokenId ? await tipsForToken(active, tokenId) : []
    let plan: ReturnType<typeof planBsv21Send> | null = null
    try {
      if (tokenId && /^\d+$/.test(String(args.give?.amount ?? ''))) {
        plan = planBsv21Send({ tokenId, tips, amount: BigInt(String(args.give!.amount)) })
      }
    } catch (err) {
      throw new TokenSwapError('bad-amount', err instanceof Error ? err.message : String(err))
    }
    const selected = plan?.selected ?? []
    const cosigned =
      selected.length > 0 &&
      (tips.some((t) => t.cosigned && selected.some((s) => s.outpoint === t.outpoint)) ||
        !(await plainValueTips(selected)))
    const path = chooseTokenSwapMakePath({
      tokenId,
      amount: args.give?.amount,
      want: args.want,
      cosigned,
    })
    const chart = createActor(tokenSwapMachine).start()
    chart.send({ type: 'MAKE', path })
    try {
      if (path.path === 'refuse') failRefused(path)
      const meta = tips.find((t) => t.sym) ?? tips[0]
      const { splitBsv21CoverToExactAmt } = await import('./marketListing')
      const lot = await splitBsv21CoverToExactAmt({
        active,
        origin: path.tokenId,
        requested: path.amount,
        covers: selected,
        ...(meta?.icon ? { icon: meta.icon } : {}),
        ...(meta?.sym ? { sym: meta.sym } : {}),
        purpose: 'token-swap',
        onStaged: (reference) => chart.send({ type: 'STAGED', reference }),
        onSigned: () => chart.send({ type: 'SIGNED_UNKNOWN' }),
      })
      const { txid, vout } = splitOutpoint(lot.outpoint)
      chart.send({ type: 'BROADCASTED', txid })
      const giveTx = lot.beef.findTxid(txid)?.tx
      if (!giveTx) throw new Error('Swap escrow transaction missing from its BEEF')
      const makerUnlockingScript = await signTokenSwapMakerInput({
        giveTx,
        giveVout: vout,
        want: path.want,
        payTo: active.address,
        privateKey: PrivateKey.fromHex(active.rootKeyHex),
      })
      const beef = await mergeLocalUnconfirmedAncestry(
        active,
        Array.from(lot.beef.toBinaryAtomic(txid)),
      )
      const offer: TokenSwapOffer = {
        protocol: TOKEN_SWAP_PROTOCOL,
        v: TOKEN_SWAP_VERSION,
        offerId: `${txid}.${vout}`,
        maker: active.identityKey.toLowerCase(),
        payTo: active.address,
        give: {
          tokenId: path.tokenId,
          amount: path.amount.toString(),
          dec: meta?.dec ?? 0,
          ...(meta?.sym ? { sym: meta.sym } : {}),
          ...(meta?.icon ? { icon: meta.icon } : {}),
          lockingScript: lot.lockingScript,
        },
        want: path.want,
        makerUnlockingScript,
        beefB64: Utils.toBase64(beef),
        createdAt: Date.now(),
      }
      saveRecord({ offer, role: 'maker', state: 'open', updatedAt: Date.now() })
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'token-swap-offer',
        note: `Offered ${offer.give.amount} ${offer.give.sym ?? 'tokens'} for ${describeWant(offer.want)}`,
        txid,
      })
      scheduleHistoryBackupPush('token-swap')
      const ms = Date.now() - startedAt
      if (ms >= 250) console.info(`[token-swap] offer done ${ms}ms`)
      return { offer }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

function describeWant(want: TokenSwapWant): string {
  return want.kind === 'sats'
    ? `${want.sats.toLocaleString()} sats`
    : `${want.amount} ${want.sym ?? 'tokens'}`
}

/**
 * Complete a maker's offer: pay output 0 exactly, take the escrowed lot.
 * Input 0 is the maker's signed lot; the taker's want-token covers and the
 * toolbox funding follow.
 */
export async function acceptTokenSwapOffer(args: { offer?: unknown }): Promise<{
  offerId: string
  txid: string
  settle: 'selfClaim' | 'peerClaim'
}> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const mark = (phase: string) => console.info(`[token-swap] +${Date.now() - startedAt}ms ${phase}`)
    const active = requireActive()
    const path = chooseTokenSwapTakePath({ offer: args.offer, takerIdentityKey: active.identityKey })
    const chart = createActor(tokenSwapMachine).start()
    chart.send({ type: 'TAKE', path })
    let reference: string | null = null
    try {
      if (path.path === 'refuse') failRefused(path)
      const { offer, settle } = path
      const give = splitOutpoint(offer.offerId)
      const offerBeef = Beef.fromBinary(Utils.toArray(offer.beefB64, 'base64'))
      const giveSource = offerBeef.findTxid(give.txid)?.tx?.outputs[give.vout]
      const giveLock = giveSource?.lockingScript?.toHex().toLowerCase()
      const decodedGive = giveLock ? decodeBsv21Binary(giveLock) : null
      if (
        !giveSource ||
        giveLock !== offer.give.lockingScript ||
        !decodedGive ||
        decodedGive.role !== 'value' ||
        decodedGive.tokenId !== offer.give.tokenId ||
        decodedGive.amount !== BigInt(offer.give.amount)
      ) {
        throw new TokenSwapError('invalid-offer', 'The offer does not carry the token lot it describes.')
      }
      if (!(await plainValueTips([{ lockingScript: giveLock }]))) {
        failRefused({ path: 'refuse', reason: 'cosigned-token', message: 'Issuer-cosigned tokens cannot be swapped.' })
      }
      const { proveTokenTipLineage } = await import('./token/proveTipLineage')
      const lineage = await proveTokenTipLineage(active, offer.offerId, offerBeef.toBinary())
      if (!lineage.ok || lineage.tokenId !== offer.give.tokenId) {
        throw new TokenSwapError(
          'TOKEN_SWAP_UNPROVEN',
          `The offered token's history could not be proven back to its deploy${lineage.ok ? '' : ` (${lineage.reason})`}. Nothing was spent.`,
        )
      }
      mark('give lineage proven')

      let covers: Array<{ outpoint: string; amt: bigint; lockingScript?: string }> = []
      let wantChange = 0n
      let wantLayout: Bsv21BinaryLayout | null = null
      if (offer.want.kind === 'token') {
        const tips = await tipsForToken(active, offer.want.tokenId)
        let plan: ReturnType<typeof planBsv21Send>
        try {
          plan = planBsv21Send({ tokenId: offer.want.tokenId, tips, amount: BigInt(offer.want.amount) })
        } catch (err) {
          throw new TokenSwapError('INSUFFICIENT_FUNDS', err instanceof Error ? err.message : String(err))
        }
        if (plan.layout !== offer.want.layout) {
          failRefused({
            path: 'refuse',
            reason: 'want-layout-mismatch',
            message: 'Your tokens use a different token format from the one this offer asks for.',
          })
        }
        if (!(await plainValueTips(plan.selected))) {
          failRefused({ path: 'refuse', reason: 'cosigned-token', message: 'Issuer-cosigned tokens cannot be swapped.' })
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

      const want = tokenSwapWantOutput(offer)
      const wantRemittance =
        settle === 'selfClaim' && offer.want.kind === 'token'
          ? buildBsv21SendRemittance({
              tokenId: offer.want.tokenId,
              amt: BigInt(offer.want.amount),
              ...(offer.want.sym ? { sym: offer.want.sym } : {}),
            })
          : {}
      const outputs = [
        { ...want, outputDescription: 'Swap payment to maker', ...wantRemittance },
        {
          lockingScript: buildBsv21ValueLock({
            tokenId: offer.give.tokenId,
            amount: BigInt(offer.give.amount),
            address: active.address,
            layout: decodedGive.layout,
          }),
          satoshis: 1,
          outputDescription: 'Swapped token to taker',
          ...buildBsv21SendRemittance({
            tokenId: offer.give.tokenId,
            amt: BigInt(offer.give.amount),
            ...(offer.give.sym ? { sym: offer.give.sym } : {}),
            ...(offer.give.icon ? { icon: offer.give.icon } : {}),
          }),
        },
        ...(offer.want.kind === 'token' && wantChange > 0n && wantLayout
          ? [
              {
                lockingScript: buildBsv21ValueLock({
                  tokenId: offer.want.tokenId,
                  amount: wantChange,
                  address: active.address,
                  layout: wantLayout,
                }),
                satoshis: 1,
                outputDescription: 'Swap token change',
                ...buildBsv21SendRemittance({
                  tokenId: offer.want.tokenId,
                  amt: wantChange,
                  ...(offer.want.sym ? { sym: offer.want.sym } : {}),
                }),
              },
            ]
          : []),
      ]
      let created: Awaited<ReturnType<typeof active.wallet.createAction>>
      try {
        created = await active.wallet.createAction({
          description: `Swap for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
          labels: [SWAP_LABEL, `token-swap-offer:${offer.offerId}`],
          inputBEEF: inputBeef.toBinary(),
          inputs: [
            { outpoint: offer.offerId, inputDescription: 'Swap escrow lot', unlockingScriptLength: 108 },
            ...covers.map((c) => ({
              outpoint: c.outpoint.replace('_', '.'),
              inputDescription: 'Swap payment token',
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
          throw new TokenSwapError(
            'INSUFFICIENT_FUNDS',
            await describeInsufficientFunds(active.wallet, offer.want.sats + 100),
          )
        }
        throw err
      }
      const signable = created.signableTransaction
      if (!signable) throw new Error('Swap did not return a signable transaction')
      reference = signable.reference
      chart.send({ type: 'STAGED', reference })
      const tx = Beef.fromBinary(signable.tx).txs
        .map((entry) => entry.tx)
        .find((candidate) =>
          candidate?.inputs.some(
            (input) =>
              String(input.sourceTXID).toLowerCase() === give.txid &&
              input.sourceOutputIndex === give.vout,
          ),
        )
      const giveIn = tx?.inputs[TOKEN_SWAP_GIVE_VIN]
      if (
        !tx ||
        String(giveIn?.sourceTXID).toLowerCase() !== give.txid ||
        giveIn?.sourceOutputIndex !== give.vout ||
        tx.outputs[TOKEN_SWAP_WANT_VOUT]?.lockingScript?.toHex() !== want.lockingScript ||
        tx.outputs[TOKEN_SWAP_WANT_VOUT]?.satoshis !== want.satoshis ||
        tx.outputs[TOKEN_SWAP_TAKER_VOUT]?.lockingScript?.toHex() !== outputs[1]!.lockingScript
      ) {
        throw new TokenSwapError(
          'TOKEN_SWAP_SHAPE_MISMATCH',
          'The wallet did not keep the swap inputs and outputs in order. Nothing was spent.',
        )
      }
      if (
        !tokenSwapMakerUnlockValid({
          tx,
          giveSatoshis: giveSource.satoshis ?? 1,
          giveLockingScript: giveLock,
          makerUnlockingScript: offer.makerUnlockingScript,
        })
      ) {
        failRefused({
          path: 'refuse',
          reason: 'unbound-signature',
          message: 'The maker signature does not unlock this swap. Nothing was spent.',
        })
      }
      tx.inputs[TOKEN_SWAP_GIVE_VIN]!.unlockingScript = UnlockingScript.fromHex(offer.makerUnlockingScript)
      const rootKey = PrivateKey.fromHex(active.rootKeyHex)
      const coverVins = covers.map((cover) => {
        const { txid, vout } = splitOutpoint(cover.outpoint)
        const vin = tx.inputs.findIndex(
          (input) => String(input.sourceTXID).toLowerCase() === txid && input.sourceOutputIndex === vout,
        )
        if (vin < 0 || !cover.lockingScript) {
          throw new TokenSwapError('TOKEN_SWAP_SHAPE_MISMATCH', 'A swap payment token input is missing.')
        }
        tx.inputs[vin]!.unlockingScriptTemplate = new P2PKH().unlock(
          rootKey,
          'all',
          false,
          1,
          LockingScript.fromHex(cover.lockingScript),
        )
        return vin
      })
      const coverSpends = await signTipInputs(tx, coverVins)
      chart.send({ type: 'SIGNED_UNKNOWN' })
      const signed = await active.wallet.signAction({
        reference,
        spends: {
          ...coverSpends,
          [TOKEN_SWAP_GIVE_VIN]: { unlockingScript: offer.makerUnlockingScript },
        },
        options: { acceptDelayedBroadcast: true },
      })
      const txid = signed.txid?.toLowerCase() ?? ''
      let atomic = signed.tx ? Array.from(signed.tx) : []
      if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('Signed swap transaction missing')
      atomic = await mergeLocalUnconfirmedAncestry(active, atomic)
      rememberBeefTree(atomic, txid)
      const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
      startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'token_swap' }))
      reference = null
      chart.send({ type: 'BROADCASTED', txid })
      mark(`signed ${txid.slice(0, 12)} — cheque registered, miners in background`)

      saveRecord({ offer, role: 'taker', state: 'taken', takeTxid: txid, updatedAt: Date.now() })
      const makerRecord = findRecord(offer.offerId, 'maker')
      if (makerRecord) {
        const filed = settle === 'selfClaim' && offer.want.kind === 'token'
        saveRecord({
          ...makerRecord,
          state: filed ? 'claimed' : 'taken',
          takeTxid: txid,
          ...(filed ? { claimTxid: txid } : {}),
        })
      }
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: offer.want.kind === 'sats' ? offer.want.sats : 0,
        method: 'token-swap',
        note: `Swapped ${describeWant(offer.want)} for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
        txid,
      })
      void import('./token')
        .then(({ listFungibles }) => listFungibles(active))
        .catch(() => {})
      scheduleHistoryBackupPush('token-swap')
      // A self-swap that wanted sats paid output 0 to our own address; sweep it
      // once this spend lease is released.
      if (settle === 'selfClaim' && offer.want.kind === 'sats') {
        setTimeout(() => {
          void claimTokenSwapProceeds({ offerId: offer.offerId, txid }).catch((err) => {
            console.warn('[token-swap] self claim deferred', err instanceof Error ? err.message : String(err))
          })
        }, 0)
      }
      mark('done')
      return { offerId: offer.offerId, txid, settle }
    } catch (err) {
      if (reference && mayAbortTokenSwap(chart.getSnapshot())) {
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
 * Maker side after a take: file output 0 (sweep the sats, or ingest the
 * token), then retire the escrow row. Runs outside the spend lease — the
 * sweep takes it itself.
 */
export async function claimTokenSwapProceeds(args: { offerId?: string; txid?: string }): Promise<{
  offerId: string
  txid: string
  proceeds: 'sats' | 'token'
}> {
  const active = requireActive()
  const record = findRecord(String(args.offerId ?? ''), 'maker')
  if (!record) {
    throw new TokenSwapError('not-maker', 'This wallet has no record of making that offer.')
  }
  const path = chooseTokenSwapClaimPath({
    offer: record.offer,
    state: record.state,
    makerIdentityKey: active.identityKey,
    txid: args.txid ?? record.takeTxid,
  })
  const chart = createActor(tokenSwapMachine).start()
  chart.send({ type: 'CLAIM', path })
  try {
    if (path.path === 'refuse') failRefused(path)
    const offer = record.offer
    const give = splitOutpoint(offer.offerId)
    const beef = await getBeefForTxidCached(active, path.txid, {
      needProof: false,
      allowUnprovenRawTx: true,
    })
    const tx = beef.findTxid(path.txid)?.tx
    const want = tokenSwapWantOutput(offer)
    if (
      !tx ||
      String(tx.inputs[TOKEN_SWAP_GIVE_VIN]?.sourceTXID).toLowerCase() !== give.txid ||
      tx.inputs[TOKEN_SWAP_GIVE_VIN]?.sourceOutputIndex !== give.vout ||
      tx.outputs[TOKEN_SWAP_WANT_VOUT]?.lockingScript?.toHex() !== want.lockingScript ||
      tx.outputs[TOKEN_SWAP_WANT_VOUT]?.satoshis !== want.satoshis
    ) {
      throw new TokenSwapError('TOKEN_SWAP_SHAPE_MISMATCH', 'That transaction does not take this offer.')
    }
    const atomic = Array.from(beef.toBinaryAtomic(path.txid))
    if (path.proceeds === 'sats') {
      const { sweepVisibleP2pkhOutpoints } = await import('./importP2pkhFunding')
      const swept = await sweepVisibleP2pkhOutpoints(active, [`${path.txid}.${TOKEN_SWAP_WANT_VOUT}`], atomic)
      if (!swept[0]?.success) throw new Error(swept[0]?.error ?? 'Swap proceeds sweep failed')
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
        },
      })
      if (!ingested.accepted) throw new Error(`Swap token ingest refused (${ingested.reason ?? 'unknown'})`)
    }
    await active.wallet
      .relinquishOutput({ basket: TOKEN_SWAP_BASKET, output: offer.offerId })
      .catch(() => {})
    const { hideSpentOutpoints } = await import('./staleOutputRelease')
    await hideSpentOutpoints([offer.offerId], path.txid, active).catch(() => 0)
    saveRecord({ ...record, state: 'claimed', takeTxid: path.txid, claimTxid: path.txid })
    chart.send({ type: 'INGESTED' })
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: offer.want.kind === 'sats' ? offer.want.sats : 0,
      method: 'token-swap-proceeds',
      note: `Swap proceeds: ${describeWant(offer.want)}`,
      txid: path.txid,
    })
    scheduleHistoryBackupPush('token-swap')
    return { offerId: offer.offerId, txid: path.txid, proceeds: path.proceeds }
  } catch (err) {
    chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    chart.stop()
  }
}

/** Spend the escrowed lot back to this wallet's token balance. */
export async function cancelTokenSwapOffer(args: { offerId?: string }): Promise<{
  offerId: string
  txid: string
}> {
  return runExclusiveSpend(async () => {
    const active = requireActive()
    const record = findRecord(String(args.offerId ?? ''), 'maker')
    if (!record) {
      throw new TokenSwapError('not-maker', 'This wallet has no record of making that offer.')
    }
    const give = splitOutpoint(record.offer.offerId)
    const { cloudSpentStatus } = await import('./chainProbeClient')
    const spent = await cloudSpentStatus(give.txid, give.vout, active.chain).catch(() => null)
    const path = chooseTokenSwapCancelPath({
      offer: record.offer,
      state: record.state,
      makerIdentityKey: active.identityKey,
      spent,
    })
    const chart = createActor(tokenSwapMachine).start()
    chart.send({ type: 'CANCEL', path })
    let reference: string | null = null
    try {
      if (path.path === 'refuse') {
        if (path.reason === 'offer-already-taken') saveRecord({ ...record, state: 'taken' })
        failRefused(path)
      }
      const offer = record.offer
      const decoded = decodeBsv21Binary(offer.give.lockingScript)
      if (!decoded) throw new TokenSwapError('invalid-offer', 'The escrowed lot is not a token output.')
      const created = await active.wallet.createAction({
        description: `Cancel swap offer for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
        labels: [SWAP_LABEL, 'token-swap-cancel', `token-swap-offer:${offer.offerId}`],
        inputBEEF: Utils.toArray(offer.beefB64, 'base64'),
        inputs: [{ outpoint: offer.offerId, inputDescription: 'Swap escrow lot', unlockingScriptLength: 108 }],
        outputs: [
          {
            lockingScript: buildBsv21ValueLock({
              tokenId: offer.give.tokenId,
              amount: BigInt(offer.give.amount),
              address: active.address,
              layout: decoded.layout,
            }),
            satoshis: 1,
            outputDescription: 'Swap lot returned',
            ...buildBsv21SendRemittance({
              tokenId: offer.give.tokenId,
              amt: BigInt(offer.give.amount),
              ...(offer.give.sym ? { sym: offer.give.sym } : {}),
              ...(offer.give.icon ? { icon: offer.give.icon } : {}),
            }),
          },
        ],
        options: { randomizeOutputs: false, signAndProcess: false, noSend: true, trustSelf: 'known' },
      })
      const signable = created.signableTransaction
      if (!signable) throw new Error('Swap cancel did not return a signable transaction')
      reference = signable.reference
      chart.send({ type: 'STAGED', reference })
      const tx = Beef.fromBinary(signable.tx).txs
        .map((entry) => entry.tx)
        .find((candidate) =>
          candidate?.inputs.some(
            (input) =>
              String(input.sourceTXID).toLowerCase() === give.txid && input.sourceOutputIndex === give.vout,
          ),
        )
      if (
        !tx ||
        String(tx.inputs[0]?.sourceTXID).toLowerCase() !== give.txid ||
        tx.inputs[0]?.sourceOutputIndex !== give.vout
      ) {
        throw new TokenSwapError('TOKEN_SWAP_SHAPE_MISMATCH', 'The wallet did not keep the escrow input first.')
      }
      tx.inputs[0]!.unlockingScriptTemplate = new P2PKH().unlock(
        PrivateKey.fromHex(active.rootKeyHex),
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
      if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('Signed swap cancel missing')
      atomic = await mergeLocalUnconfirmedAncestry(active, atomic)
      rememberBeefTree(atomic, txid)
      const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
      startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'token_swap' }))
      reference = null
      chart.send({ type: 'BROADCASTED', txid })
      saveRecord({ ...record, state: 'cancelled', cancelTxid: txid })
      chart.send({ type: 'COMMITTED' })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'token-swap-cancel',
        note: `Cancelled swap offer for ${offer.give.amount} ${offer.give.sym ?? 'tokens'}`,
        txid,
      })
      void import('./token')
        .then(({ listFungibles }) => listFungibles(active))
        .catch(() => {})
      scheduleHistoryBackupPush('token-swap')
      return { offerId: offer.offerId, txid }
    } catch (err) {
      if (reference && mayAbortTokenSwap(chart.getSnapshot())) {
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

/** Parse a shared offer without touching the wallet (preview / permission copy). */
export function previewTokenSwapOffer(raw: unknown): TokenSwapOffer | null {
  return parseTokenSwapOffer(raw)
}
