/**
 * Send BRC-162 value tips: spend 162 inputs, emit payee (+ change) 162 value
 * outputs with conserved `amt`. Dust/fees from ordinary BSV.
 *
 * NEW sends never emit application/1sat-ft+json. Remittance is BRC-163
 * (basket `bsv21`). Subject outputs carry a 176 BEEF packet.
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import {
  issuerFromColourTags,
  normalizeColourOrigin,
  type ColourTip,
} from './colourCoins'
import {
  BSV21_BASKET,
} from './bsv21'
import { decodeBsv21Binary } from './bsv21Binary'
import { fillTokenParentBodies } from './bsv21Prove'
import {
  assertBsv21SendConservation,
  buildBsv21SendOutputs,
  buildBsv21SubjectBeef,
  classifyBsv21SendOutputs,
  planBsv21Send,
  tipFromBsv21Script,
  type Bsv21SendTip,
} from './bsv21Send'
import { listBsv21BinaryTips, listBsv21BinaryTokens } from './colourListing'
import { mergeIconTxIntoBeef } from './tokenIconResolve'
import {
  failOutboundSendPending,
  noteOutboundSendComplete,
  noteOutboundSendPending,
} from './appActivity'
import {
  buildMergedInputBeef,
  getBeefForTxidCached,
  rememberBeefTree,
} from './beefCache'
import {
  normalizeOutpoint,
  setCollectableVerifyWalkDeferred,
  resumeCollectableVerifyWalk,
} from './collectables'
import { scheduleHistoryBackupPush } from './deviceSync'
import { listFriends, resolvePaymentRecipient } from './friends'
import { stampBrc164Id } from './itemAccess'
import { isCovenantLockedScript } from './collectableTipKind'
import { p2pkhScriptHex } from './ordinalOwnership'
import { assertOnlineForPayment } from './paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from './paymentProgress'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import {
  FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
  withFungibleCreateActionTimeout,
} from './sendFungible'
import { getActiveWallet, type ActiveWallet } from './session'
import { markItemsSent } from './sentItemGuard'
import { runExclusiveSpend } from './spendGuard'
import { leaseSpendPriority } from './walletCoordinator'

function wireOutpoint(op: string): string {
  return op.includes('_') ? op.replace(/_(\d+)$/, '.$1') : op
}

async function fetchRawTokenBody(
  wallet: ActiveWallet,
  txid: string,
): Promise<Beef | null> {
  try {
    return await getBeefForTxidCached(wallet, txid, {
      needProof: false,
      allowUnprovenRawTx: true,
    })
  } catch (err) {
    console.warn('[bsv21] token parent body fetch failed', txid, err)
    return null
  }
}

function atomicBeefFromWalletResult(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return undefined
}

/**
 * A mint that never got a locking script on listOutputs still has the 162
 * body in local BEEF. Spend that — do not wait for an indexer to rewrite it.
 */
async function recoverBsv21TipsFromLocalBeef(
  wallet: ActiveWallet,
  tokenId: string,
): Promise<Bsv21SendTip[]> {
  const { getLocalBeefForTxid } = await import('./beefCache')
  const { getCachedFungibles } = await import('./fungibles')
  const want = normalizeColourOrigin(tokenId)
  const candidates = new Set<string>()
  for (const token of getCachedFungibles()) {
    const id = normalizeColourOrigin(token.tokenId)
    const aliases = (token.tokenIds ?? []).map(normalizeColourOrigin)
    if (id === want || aliases.includes(want)) {
      if (token.outpoint) candidates.add(token.outpoint)
    }
  }
  const tips: Bsv21SendTip[] = []
  for (const op of candidates) {
    const wire = wireOutpoint(op)
    const [txid, voutRaw] = wire.split('.')
    if (!txid) continue
    const beef = await getLocalBeefForTxid(wallet, txid)
    const hex = beef
      ?.findTxid(txid.toLowerCase())
      ?.tx?.outputs?.[Number(voutRaw)]
      ?.lockingScript?.toHex()
    if (!hex) continue
    const decoded = tipFromBsv21Script({
      outpoint: op,
      lockingScript: hex,
      satoshis: 1,
    })
    if (!decoded || !decodeBsv21Binary(hex)) continue
    if (normalizeColourOrigin(decoded.tokenId) !== want) continue
    tips.push({
      outpoint: decoded.outpoint,
      tokenId: decoded.tokenId,
      amt: decoded.amt,
      lockingScript: hex,
    })
  }
  if (tips.length > 0) {
    console.info(
      `[bsv21] recovered ${tips.length} tip(s) from local BEEF (listOutputs had no 162 lock)`,
    )
  }
  return tips
}

/**
 * BRC-100 auto-signs managed change only. Inscribed 1sat-ft tips come back as
 * signable — unlock with the root key, same as collectables.
 */
export async function signColourTipTransfer(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  outpoints: string[]
}): Promise<{ txid: string; atomicBeef: number[] }> {
  const targets = new Map<string, number>()
  for (const op of args.outpoints) {
    const [txidIn, voutRaw] = wireOutpoint(op).split('.')
    targets.set(`${txidIn?.toLowerCase()}.${Number(voutRaw)}`, Number(voutRaw))
  }

  rememberBeefTree(
    Array.isArray(args.signable.tx)
      ? args.signable.tx
      : Array.from(args.signable.tx),
  )
  const beef = Beef.fromBinary(args.signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs ?? []) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${
        input?.sourceOutputIndex
      }`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('Token tip missing from the signable transaction')
  }

  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    if (!input.sourceTransaction && input.sourceTXID) {
      try {
        const extra = await getBeefForTxidCached(
          args.wallet,
          String(input.sourceTXID),
          { needProof: true },
        )
        beef.mergeBeef(extra.toBinary())
        input.sourceTransaction = beef.findTxid(String(input.sourceTXID))?.tx
      } catch (err) {
        console.warn('[bsv21] source tx hydrate failed', input.sourceTXID, err)
      }
    }
    const locking =
      input.sourceTransaction?.outputs[
        input.sourceOutputIndex
      ]?.lockingScript?.toHex()
    if (isCovenantLockedScript(locking)) {
      throw new Error(
        'This token tip is covenant-locked and cannot be spent with a P2PKH unlock.',
      )
    }
  }

  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const sourceOut =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]
    const satoshis = sourceOut?.satoshis
    const lockingScript = sourceOut?.lockingScript
    if (typeof satoshis !== 'number' || !lockingScript) {
      throw new Error('Token tip is missing its source transaction')
    }
    // Tips are inscription ‖ P2PKH — sighash scriptCode must be the full locking
    // script. SetupClient.getUnlockP2PKH only hashes bare P2PKH and fails
    // CHECKSIG ("top stack element must be truthy") on ordinal tips.
    input.unlockingScriptTemplate = new P2PKH().unlock(
      rootKey,
      'all',
      false,
      satoshis,
      lockingScript,
    )
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign the token transfer')
    spends[vin] = { unlockingScript }
  }

  let signed
  try {
    signed = await args.wallet.wallet.signAction({
      reference: args.signable.reference,
      spends,
      options: { noSend: true },
    })
  } catch (err) {
    const {
      isReviewActionsError,
      formatReviewActionsError,
      recoverFromReviewActions,
    } = await import('./actionReview')
    if (isReviewActionsError(err)) {
      await recoverFromReviewActions({
        err,
        reference: args.signable.reference,
        tipOutpoints: [...args.outpoints],
        active: args.wallet,
      })
      throw new Error(formatReviewActionsError(err))
    }
    throw err
  }

  const txid =
    typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!txid) throw new Error('Token transfer returned no txid after signing')

  let atomicBeef = atomicBeefFromWalletResult(signed)
  if (!atomicBeef?.length) {
    const wrap = new Beef()
    wrap.mergeBeef(args.signable.tx)
    wrap.mergeTransaction(unsigned)
    wrap.atomicTxid = undefined
    try {
      atomicBeef = wrap.toBinaryAtomic(txid)
    } catch {
      atomicBeef = wrap.toBinary()
    }
  }
  if (!atomicBeef?.length) {
    throw new Error('Token transfer returned no signed BEEF')
  }
  rememberBeefTree(atomicBeef, txid)
  return { txid, atomicBeef }
}

export async function sendColourCoins(args: {
  origin: string
  /** Face-value units to send. */
  amount: number
  toAddress: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
  sym?: string
  supply?: 'locked' | 'open'
  maxSupply?: number | null
  /** Decorative icon inscription to echo into child remittance. */
  icon?: string
  /**
   * Spend exactly these tips (e.g. combine). When omitted, greedy-cover
   * `amount` from listed tips.
   */
  tips?: ColourTip[]
  /** Skip peer remittance (self-combine). */
  skipPeerNotify?: boolean
  actionDescription?: string
  actionLabel?: string
}): Promise<{ txid: string; tipsSpent: number; change: number }> {
  const origin = normalizeColourOrigin(args.origin)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const listed162 = await listBsv21BinaryTips(active, {
    includeCustomInstructions: false,
  })
  const fromArgs: Bsv21SendTip[] = (args.tips ?? []).flatMap((t) => {
    const decoded = tipFromBsv21Script({
      outpoint: t.outpoint,
      lockingScript: t.lockingScript,
      satoshis: t.satoshis,
      customInstructions: t.customInstructions,
      tags: t.tags,
    })
    if (decoded && t.lockingScript && decodeBsv21Binary(t.lockingScript)) {
      return [decoded]
    }
    return []
  })
  const fromBasket = listed162
    .filter(
      (t) =>
        t.tokenId === origin &&
        !!t.lockingScript &&
        !!decodeBsv21Binary(t.lockingScript),
    )
    .map((t) => ({
      outpoint: t.outpoint,
      tokenId: t.tokenId,
      amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
      lockingScript: t.lockingScript,
    }))
  if (fromArgs.length === 0 && fromBasket.length === 0) {
    fromBasket.push(...(await recoverBsv21TipsFromLocalBeef(active, origin)))
  }
  const plan = planBsv21Send({
    tokenId: origin,
    amount: BigInt(args.amount),
    tips: fromArgs.length ? fromArgs : fromBasket,
  })
  const selected = plan.selected
  const change = Number(plan.changeAmt)
  const amount = Number(plan.payeeAmt)
  console.info(
    `[bsv21] send plan tips=${selected.length} amount=${amount} change=${change} origin=${origin.slice(0, 16)}`,
  )
  const selectedColour: ColourTip[] = selected.map((t) => ({
    outpoint: t.outpoint,
    origin,
    satoshis: 1,
    amt: Number(t.amt),
    proven: true,
    lockingScript: t.lockingScript,
  }))
  const sym = args.sym?.trim() || 'Token'
  const primary = selectedColour[0]!
  const actionLabel = args.actionLabel ?? 'handcash-send-bsv21'
  const actionDescription = args.actionDescription ?? 'Send token'

  setPaymentProgress(
    'preparing',
    args.skipPeerNotify ? 'Waiting to combine tips' : 'Waiting to send token',
    primary.outpoint,
    null,
    'token_transfer',
  )
  setCollectableVerifyWalkDeferred(true)
  const spendPriority = leaseSpendPriority('send-fungible')
  const touchSpendPriority = setInterval(() => spendPriority.touch(), 30_000)
  const outboundPending = beginPendingSend({
    to: args.toAddress,
    sats: selected.length,
    friendLabel: args.friendLabel ?? null,
  })
  const activityItem = {
    name: sym,
    origin,
    outpoint: primary.outpoint,
    tokenId: origin,
    amt: String(amount),
    dec: 0,
  }
  noteOutboundSendPending({
    pendingId: outboundPending.id,
    sats: selected.length,
    to: args.toAddress,
    friendLabel: args.friendLabel ?? null,
    recipientIdentityKey: args.recipientIdentityKey ?? null,
    item: activityItem,
  })

  try {
    return await runExclusiveSpend(
      async () => {
      assertOnlineForPayment()
      const wallet = getActiveWallet()
      if (!wallet) throw new Error('Wallet locked')
      {
        const { abortReservedActionBatches } = await import('./actionReview')
        await abortReservedActionBatches(wallet, { budgetMs: 1500 })
      }

      setPaymentProgress(
        'building',
        args.skipPeerNotify ? 'Combining tips…' : 'Preparing token…',
        primary.outpoint,
      )
      const to = await resolvePaymentRecipient(args.toAddress, wallet.chain)
      const issuer = (() => {
        for (const tip of listed162) {
          if (tip.tokenId === origin && tip.issuer) return tip.issuer
        }
        for (const tip of selectedColour) {
          const fromTags = issuerFromColourTags(tip.tags)
          if (fromTags) return fromTags
          try {
            const o = JSON.parse(String(tip.customInstructions ?? '')) as {
              issuer?: unknown
            }
            if (typeof o.issuer === 'string' && o.issuer.trim()) return o.issuer.trim()
          } catch {
            /* next tip */
          }
        }
        return undefined
      })()
      const icon =
        args.icon ||
        listed162.find((t) => t.tokenId === origin && t.icon)?.icon
      let plannedOutputs
      try {
        plannedOutputs = buildBsv21SendOutputs({
          tokenId: origin,
          payeeAmt: plan.payeeAmt,
          changeAmt: plan.changeAmt,
          payeeAddress: to,
          changeAddress: wallet.address,
          sym,
          dec: 0,
          issuer,
          icon,
        })
      } catch {
        throw new Error('Invalid recipient address or identity key')
      }
      const peerKey =
        args.skipPeerNotify
          ? null
          : args.recipientIdentityKey?.trim().toLowerCase() || null
      const spendOutpoints = selected.map((tip) => wireOutpoint(tip.outpoint))
      const knownTxids = [
        ...new Set(
          spendOutpoints
            .map((op) => op.split('.')[0]?.toLowerCase())
            .filter((txid): txid is string => Boolean(txid)),
        ),
      ]

      // Fresh mint BEEF has no merkle bumps yet. Do not discard it to hunt
      // proofs — that is what wedged KING send for 90s after mint-studio.
      setPaymentProgress(
        'building',
        'Loading tip…',
        primary.outpoint,
      )
      let inputBEEF: number[]
      try {
        inputBEEF = await buildMergedInputBeef(
          wallet,
          spendOutpoints,
          wireOutpoint,
          { needProof: false, allowUnprovenRawTx: true, hydrate: false },
        )
        {
          const beef = await fillTokenParentBodies(
            Beef.fromBinary(inputBEEF),
            (txid) => fetchRawTokenBody(wallet, txid),
            knownTxids,
          )
          if (icon) await mergeIconTxIntoBeef(wallet, beef, icon)
          inputBEEF = beef.toBinary()
        }
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? err.message.replace(/collectable/i, 'token tip')
            : 'Could not load the transaction that holds this token tip. Refresh, then send again.',
        )
      }

      const outputs = plannedOutputs.map((o) => ({
        lockingScript: o.lockingScript,
        satoshis: 1 as const,
        outputDescription: o.outputDescription,
        ...(o.basket ? { basket: o.basket } : {}),
        tags: stampBrc164Id([
          ...o.tags,
          ...(args.icon ? [`icon:${args.icon}`] : []),
          ...(issuer ? [`issuer:${issuer}`] : []),
        ]),
        customInstructions: o.customInstructions,
      }))

      setPaymentProgress(
        'signing',
        args.skipPeerNotify ? 'Signing token…' : 'Signing token…',
        primary.outpoint,
      )
      console.info(
        `[bsv21] createAction start tips=${selected.length} amount=${amount} change=${change}`,
      )
      let actionReference: string | undefined
      try {
      let created: Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>
      try {
        created = await withFungibleCreateActionTimeout(
          wallet.wallet.createAction({
            description: actionDescription,
            inputBEEF,
            inputs: selected.map((tip) => ({
              outpoint: wireOutpoint(tip.outpoint),
              inputDescription: 'BSV-21 value',
              unlockingScriptLength: 108,
            })),
            outputs,
            options: {
              trustSelf: 'known',
              ...(knownTxids.length > 0 ? { knownTxids } : {}),
              noSend: true,
              randomizeOutputs: false,
              signAndProcess: true,
            },
            labels: [BSV21_BASKET, actionLabel],
          }),
          FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
        )
      } catch (err) {
        const { isReservedActionBatchError, abortReservedActionBatches } =
          await import('./actionReview')
        if (isReservedActionBatchError(err)) {
          await abortReservedActionBatches(wallet)
          created = await withFungibleCreateActionTimeout(
            wallet.wallet.createAction({
              description: actionDescription,
              inputBEEF,
              inputs: selected.map((tip) => ({
                outpoint: wireOutpoint(tip.outpoint),
                inputDescription: 'BSV-21 value',
                unlockingScriptLength: 108,
              })),
              outputs,
              options: {
                trustSelf: 'known',
                ...(knownTxids.length > 0 ? { knownTxids } : {}),
                noSend: true,
                randomizeOutputs: false,
                signAndProcess: true,
              },
              labels: [BSV21_BASKET, actionLabel],
            }),
            FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
          )
        } else {
          throw err
        }
      }

      actionReference =
        typeof created.signableTransaction?.reference === 'string'
          ? created.signableTransaction.reference
          : undefined

      let txid =
        typeof created.txid === 'string' && /^[0-9a-f]{64}$/i.test(created.txid)
          ? created.txid.toLowerCase()
          : ''
      let atomic = atomicBeefFromWalletResult(created)

      if (!txid) {
        const signable = created.signableTransaction as
          | SignableTransaction
          | undefined
        if (!signable) {
          throw new Error('Token transfer produced no txid')
        }
        actionReference = signable.reference
        console.info('[bsv21] createAction returned signable — unlocking tip(s)')
        setPaymentProgress(
          'signing',
          'Signing token tip…',
          primary.outpoint,
        )
        const signed = await signColourTipTransfer({
          wallet,
          signable,
          outpoints: spendOutpoints,
        })
        txid = signed.txid
        atomic = signed.atomicBeef
        actionReference = undefined
      }
      console.info(`[bsv21] createAction done txid=${txid}`)

      if (!atomic?.length) {
        try {
          const beef = await getBeefForTxidCached(wallet, txid, {
            needProof: false,
            allowUnprovenRawTx: true,
          })
          atomic = Array.from(beef.toBinaryAtomic(txid))
        } catch {
          try {
            const wrap = Beef.fromBinary(
              Array.from(
                (
                  await getBeefForTxidCached(wallet, txid, {
                    needProof: false,
                    allowUnprovenRawTx: true,
                  })
                ).toBinary(),
              ),
            )
            atomic = wrap.toBinaryAtomic(txid)
          } catch {
            // fall through
          }
        }
      }
      if (!atomic?.length) {
        throw new Error('Token transfer missing AtomicBEEF for broadcast')
      }
      let remainingAmt = change
      let remainingOp: string | undefined
      let payeeOutpoints: string[] = []
      try {
        const signedBeef = Beef.fromBinary(atomic)
        signedBeef.atomicTxid = undefined
        try {
          signedBeef.mergeBeef(inputBEEF)
        } catch (err) {
          console.warn('[bsv21] merge inputBEEF into signed BEEF failed', err)
        }
        const withParents = await fillTokenParentBodies(
          signedBeef,
          (parentTxid) => fetchRawTokenBody(wallet, parentTxid),
          [txid, ...knownTxids],
        )
        const signedTx =
          withParents.findTxid(txid)?.tx ?? withParents.findAtomicTransaction(txid)
        if (signedTx) {
          const classified = classifyBsv21SendOutputs({
            tx: signedTx,
            tokenId: origin,
            payeeRestHex: p2pkhScriptHex(to),
            changeRestHex: p2pkhScriptHex(wallet.address),
            payeeAmt: plan.payeeAmt,
            changeAmt: plan.changeAmt,
          })
          assertBsv21SendConservation({
            payeeAmt: plan.payeeAmt,
            changeAmt: plan.changeAmt,
            classified,
          })
          remainingAmt = Number(
            classified.change.reduce((sum, out) => sum + out.amt, 0n),
          )
          remainingOp = classified.change[0]
            ? `${txid}_${classified.change[0].vout}`
            : undefined
          payeeOutpoints = classified.payee.map((out) => `${txid}_${out.vout}`)
          console.info(
            `[bsv21] signed outputs payee=${classified.payee.map((o) => `${o.vout}:${o.amt}`).join(',') || 'none'} change=${classified.change.map((o) => `${o.vout}:${o.amt}`).join(',') || 'none'}`,
          )
          const { beef: proved } = buildBsv21SubjectBeef({
            parentBeef: withParents,
            subjectTx: signedTx,
          })
          try {
            atomic = Array.from(proved.toBinaryAtomic(txid))
          } catch {
            atomic = proved.toBinary()
          }
        }
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? err.message
            : 'BRC-176 prove failed for the token send',
        )
      }
      if (plan.changeAmt > 0n && !remainingOp) {
        throw new Error('Token change missing from the signed transaction')
      }
      rememberBeefTree(atomic, txid)

      try {
        await wallet.wallet.actionBatch.abort()
      } catch {
        /* unused funding reservations only */
      }

      const { sealSpentInputsOfSignedTx, releaseSealedInputsOfUnsentTx } =
        await import('./staleOutputRelease')
      await sealSpentInputsOfSignedTx(txid, atomic)
      // Signed — settle owns broadcast; do not abort this reference on peer miss.
      actionReference = undefined

      if (peerKey) {
        setPaymentProgress(
          'finishing',
          'Delivering token to recipient',
          primary.outpoint,
        )
        const { notifyPeerItemIncoming } = await import('./messageTransport')
        const friend = listFriends().find(
          (f) => f.identityKey.toLowerCase() === peerKey,
        )
        const asset = {
          kind: 'fungible' as const,
          tokenId: origin,
          amount: String(amount),
          sym,
          dec: 0,
          ...(args.icon ? { icon: args.icon } : {}),
        }
        const { recordTransactionStage } = await import('./transactionTelemetry')
        try {
          const delivered = await notifyPeerItemIncoming({
            recipientIdentityKey: peerKey,
            rootKeyHex: wallet.rootKeyHex,
            senderIdentityKey: wallet.identityKey,
            messagebox: friend?.messagebox,
            txid,
            itemName: sym,
            asset,
            atomicBeef: atomic,
          })
          if (delivered.delivered === 'cloud') {
            recordTransactionStage('peer_delivered', {
              flow: 'token_transfer',
              txid,
            })
          } else {
            const { enqueuePendingItemRemit } = await import('./pendingItemOutbox')
            enqueuePendingItemRemit({
              payeeIdentityKey: peerKey,
              senderIdentityKey: wallet.identityKey,
              txid,
              itemName: sym,
              messagebox: friend?.messagebox,
              asset,
              flow: 'token_transfer',
            })
            recordTransactionStage('peer_delivery_queued', {
              flow: 'token_transfer',
              txid,
              blockerCode: 'peer_box_unreachable',
            })
          }
        } catch (error) {
          const { enqueuePendingItemRemit } = await import('./pendingItemOutbox')
          enqueuePendingItemRemit({
            payeeIdentityKey: peerKey,
            senderIdentityKey: wallet.identityKey,
            txid,
            itemName: sym,
            messagebox: friend?.messagebox,
            asset,
            flow: 'token_transfer',
          })
          recordTransactionStage('peer_delivery_queued', {
            flow: 'token_transfer',
            txid,
            blockerCode: 'peer_delivery_error',
          })
          console.warn(
            '[send-colour] peer delivery queued',
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      setPaymentProgress('broadcasting', 'Broadcasting token transfer', primary.outpoint)
      const ok = await broadcastAtomicBeef(txid, atomic)
      if (!ok) {
        await releaseSealedInputsOfUnsentTx(txid, atomic)
        throw new Error('Token transfer was not accepted by the network')
      }
      const spent = selected.map((t) => normalizeOutpoint(t.outpoint))
      markItemsSent([
        ...spent.map((outpoint) => ({ outpoint, txid })),
        ...payeeOutpoints.map((outpoint) => ({
          outpoint,
          txid,
          settle: 'peerDeliver' as const,
        })),
      ])
      for (const op of payeeOutpoints) {
        try {
          await wallet.wallet.relinquishOutput({
            basket: BSV21_BASKET,
            output: wireOutpoint(op),
          } as never)
        } catch {
          /* createAction may already have dropped it */
        }
      }
      noteOutboundSendComplete({
        pendingId: outboundPending.id,
        txid,
        sats: selected.length,
        to: args.toAddress,
        friendLabel: args.friendLabel ?? null,
        recipientIdentityKey: args.recipientIdentityKey ?? null,
        item: activityItem,
      })
      completePendingSend(outboundPending.id, txid)
      clearPaymentProgress()
      scheduleHistoryBackupPush('sendColourCoins')
      const { paintFungibleAfterSpend, getFungible } = await import('./fungibles')
      paintFungibleAfterSpend({
        tokenId: origin,
        remainingAmt,
        outpoint: remainingOp,
        sym,
        icon: args.icon,
        dec: getFungible(origin)?.dec ?? 0,
      })
      return { txid, tipsSpent: selected.length, change: remainingAmt }
      } finally {
        if (actionReference) {
          try {
            await wallet.wallet.abortAction({ reference: actionReference })
          } catch {
            /* best-effort — outer catch also releaseStuckNosends */
          }
          try {
            await wallet.wallet.actionBatch.abort()
          } catch {
            /* unused funding */
          }
        }
      }
    },
      () => {
        setPaymentProgress(
          'preparing',
          args.skipPeerNotify ? 'Waiting to combine tips' : 'Waiting to send token',
          primary.outpoint,
        )
      },
      { promote: 'light' },
    )
  } catch (err) {
    clearPendingSend(outboundPending.id)
    failOutboundSendPending({
      pendingId: outboundPending.id,
      reason: err instanceof Error ? err.message : String(err),
    })
    clearPaymentProgress()
    // Failed create/sign leaves the tip spent inside a noSend action — abort so
    // Collect still lists KING (chain tip is unspent; only local state was dirty).
    try {
      const active = getActiveWallet()
      if (active) {
        const { releaseStuckNosends, abortReservedActionBatches } =
          await import('./actionReview')
        await releaseStuckNosends(active)
        await abortReservedActionBatches(active)
        void listBsv21BinaryTokens(active).catch(() => {})
      }
    } catch (recoverErr) {
      console.warn('[bsv21] tip restore after failed send skipped', recoverErr)
    }
    throw err
  } finally {
    clearInterval(touchSpendPriority)
    spendPriority.release()
    setCollectableVerifyWalkDeferred(false)
    resumeCollectableVerifyWalk()
  }
}
export async function combineColourTips(args: {
  origin: string
  sym?: string
  supply?: 'locked' | 'open'
  maxSupply?: number | null
}): Promise<{ txid: string; tipsSpent: number }> {
  const origin = normalizeColourOrigin(args.origin)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const listed162 = await listBsv21BinaryTips(active)
  const mine = listed162.filter((t) => t.tokenId === origin)
  if (mine.length < 2) {
    throw new Error('Already a single tip — nothing to combine')
  }
  const amount = mine.reduce((s, t) => s + Number(t.amt.replace(/\D/g, '') || '0'), 0)
  const result = await sendColourCoins({
    origin,
    amount,
    toAddress: active.address,
    skipPeerNotify: true,
    sym: args.sym,
    actionDescription: 'Combine token tips',
    actionLabel: 'handcash-combine-bsv21',
  })
  return { txid: result.txid, tipsSpent: result.tipsSpent }
}
