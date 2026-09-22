import { getActiveWallet } from '../session'

/**
 * Send BRC-162 value tips: spend 162 inputs, emit payee (+ change) 162 value
 * outputs with conserved `amt`. Dust/fees from ordinary BSV.
 *
 * Remittance is BRC-163 (basket `bsv21`). Subject outputs carry BRC-176 BEEF.
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import {
  BSV21_BASKET,
  issuerFromBsv21Tags,
  normalizeTokenId,
  requireTokenId,
} from './types'
import { decodeBsv21Binary } from './decode162'
import { fillTokenParentBodies } from './prove176'
import {
  assertBsv21SendConservation,
  buildBsv21SendOutputs,
  buildBsv21SubjectBeef,
  classifyBsv21SendOutputs,
  planBsv21Send,
  tipFromBsv21Script,
  type Bsv21SendTip,
} from './sendPlan'
import { listBsv21BinaryTips, listBsv21BinaryTokens } from './listTips'
import { mergeIconTxIntoBeef } from './icons/resolve'
import {
  failOutboundSendPending,
  noteOutboundSendComplete,
  noteOutboundSendPending,
} from '../appActivity'
import {
  buildMergedInputBeef,
  getBeefForTxidCached,
  inboxSubjectBeef,
  mergeLocalUnconfirmedAncestry,
  rememberBeefTree,
} from '../beefCache'
import {
  normalizeOutpoint,
  setCollectableVerifyWalkDeferred,
  resumeCollectableVerifyWalk,
} from '../collectables'
import { scheduleHistoryBackupPush } from '../deviceSync'
import { listFriends, resolvePaymentRecipient } from '../friends'
import { stampBrc164Id } from '../itemAccess'
import { isCovenantLockedScript } from '../collectableTipKind'
import { p2pkhScriptHex } from '../ordinalOwnership'
import { assertOnlineForPayment } from '../paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from '../paymentProgress'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from '../pendingSend'
import {
  FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
  withFungibleCreateActionTimeout,
} from './sendEntry'
import { type ActiveWallet } from '../session'
import { markItemsSent } from '../sentItemGuard'
import { runExclusiveSpend } from '../spendGuard'
import { leaseSpendPriority } from '../walletCoordinator'

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
  const { getLocalBeefForTxid } = await import('../beefCache')
  const { getCachedFungibles } = await import('./list')
  const want = requireTokenId(tokenId)
  const candidates = new Set<string>()
  for (const token of getCachedFungibles()) {
    const id = normalizeTokenId(token.tokenId)
    const aliases = (token.tokenIds ?? []).flatMap((candidate) => {
      const normalized = normalizeTokenId(candidate)
      return normalized ? [normalized] : []
    })
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
    if (normalizeTokenId(decoded.tokenId) !== want) continue
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
 * Complete a staged BSV-21 transfer with the wallet root P2PKH key.
 */
export async function signBsv21TipTransfer(args: {
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
    } = await import('../actionReview')
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

export async function sendBsv21Tokens(args: {
  tokenId: string
  /** Face-value units to send. */
  amount: number
  toAddress: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
  sym?: string
  /** Decorative icon inscription to echo into child remittance. */
  icon?: string
  /**
   * Spend exactly these tips (e.g. combine). When omitted, greedy-cover
   * `amount` from listed tips.
   */
  tips?: Bsv21SendTip[]
  /** Skip peer remittance (self-combine). */
  skipPeerNotify?: boolean
  actionDescription?: string
  actionLabel?: string
}): Promise<{ txid: string; tipsSpent: number; change: number }> {
  const tokenId = requireTokenId(args.tokenId)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const listed162 = await listBsv21BinaryTips(active, {
    includeCustomInstructions: false,
  })
  const fromArgs: Bsv21SendTip[] = (args.tips ?? []).flatMap((t) => {
    const decoded = tipFromBsv21Script({
      outpoint: t.outpoint,
      lockingScript: t.lockingScript,
      customInstructions: t.customInstructions,
      tags: t.tags,
    })
    if (decoded && t.lockingScript && decodeBsv21Binary(t.lockingScript)) {
      return [decoded]
    }
    return []
  })
  const fromBasket: Bsv21SendTip[] = listed162
    .filter(
      (t) =>
        t.tokenId === tokenId &&
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
    fromBasket.push(...(await recoverBsv21TipsFromLocalBeef(active, tokenId)))
  }
  const plan = planBsv21Send({
    tokenId,
    amount: BigInt(args.amount),
    tips: fromArgs.length ? fromArgs : fromBasket,
  })
  const selected = plan.selected
  const change = Number(plan.changeAmt)
  const amount = Number(plan.payeeAmt)
  console.info(
    `[bsv21] send plan tips=${selected.length} amount=${amount} change=${change} token=${tokenId.slice(0, 16)}`,
  )
  const sym = args.sym?.trim() || 'Token'
  const primary = selected[0]!
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
    origin: tokenId,
    outpoint: primary.outpoint,
    tokenId,
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
        const { abortReservedActionBatches } = await import('../actionReview')
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
          if (tip.tokenId === tokenId && tip.issuer) return tip.issuer
        }
        for (const tip of selected) {
          const fromTags = issuerFromBsv21Tags(tip.tags)
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
        listed162.find((t) => t.tokenId === tokenId && t.icon)?.icon
      let plannedOutputs
      try {
        plannedOutputs = buildBsv21SendOutputs({
          tokenId,
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
          const { checkBsv21BroadcastValidity } = await import(
            './broadcastValidity'
          )
          const validity = await checkBsv21BroadcastValidity({
            beef,
            outpoints: selected.map((tip) => tip.outpoint),
            tokenId,
            chain: wallet.chain,
          })
          if (validity.kind === 'refuse') {
            const ancestor = validity.txid
              ? ` ${validity.txid.slice(0, 12)}`
              : ''
            // A rejected ancestor is terminal. Record it so the cheque that
            // produced this tip stops holding its own inputs sealed.
            if (validity.reason === 'ancestor-rejected' && validity.txid) {
              const { noteArcadeRejectedTx } = await import(
                '../arcadeSubmitGuard'
              )
              noteArcadeRejectedTx(validity.txid)
            }
            console.warn(
              `[bsv21] pre-sign refuse ${validity.reason}${ancestor} — ${validity.detail}`,
            )
            throw new Error(
              `BSV-21 send refused (${validity.reason}${ancestor}): ${validity.detail}`,
            )
          }
          console.info(
            `[bsv21] pre-sign valid token ancestry=${validity.ancestryTxids.length}`,
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
          await import('../actionReview')
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
        const signed = await signBsv21TipTransfer({
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
        if (!signedTx) {
          throw new Error('Signed token transaction body is missing')
        }
        {
          const classified = classifyBsv21SendOutputs({
            tx: signedTx,
            tokenId,
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
      const peerAtomic = inboxSubjectBeef(atomic, txid) ?? atomic
      atomic = await mergeLocalUnconfirmedAncestry(wallet, atomic)
      rememberBeefTree(atomic, txid)
      rememberBeefTree(peerAtomic, txid)

      try {
        await wallet.wallet.actionBatch.abort()
      } catch {
        /* unused funding reservations only */
      }

      const { registerSignedSend, startSignedSendPropagation } =
        await import('../signedSendLifecycle')
      const signedSend = await registerSignedSend({
        txid,
        atomicBeef: atomic,
        flow: 'token_transfer',
        satoshis: selected.length,
        to: args.toAddress,
      })
      // Signed — settle owns broadcast; do not abort this reference on peer miss.
      actionReference = undefined
      if (peerKey) {
        setPaymentProgress(
          'finishing',
          'Notifying token recipient',
          primary.outpoint,
        )
        const asset = {
          kind: 'fungible' as const,
          tokenId,
          amount: String(amount),
          sym,
          dec: 0,
          ...(args.icon ? { icon: args.icon } : {}),
        }
        void (async () => {
          const { notifyPeerItemIncoming } = await import('../messageTransport')
          const { recordTransactionStage } = await import('../transactionTelemetry')
          const friend = listFriends().find(
            (f) => f.identityKey.toLowerCase() === peerKey,
          )
          try {
            const delivered = await notifyPeerItemIncoming({
              recipientIdentityKey: peerKey,
              rootKeyHex: wallet.rootKeyHex,
              senderIdentityKey: wallet.identityKey,
              messagebox: friend?.messagebox,
              txid,
              itemName: sym,
              asset,
              atomicBeef: peerAtomic,
            })
            console.info(
              `[bsv21] peer notify box=${delivered.delivered} beefInBox=${delivered.beefInBox}`,
            )
            if (
              (delivered.delivered === 'cloud' || delivered.delivered === 'direct') &&
              delivered.beefInBox
            ) {
              recordTransactionStage('peer_delivered', {
                flow: 'token_transfer',
                txid,
              })
              return
            }
            const { enqueuePendingItemRemit } = await import('../pendingItemOutbox')
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
              blockerCode: delivered.beefInBox
                ? 'peer_box_unreachable'
                : 'beef_omitted_box_cap',
            })
          } catch (error) {
            const { enqueuePendingItemRemit } = await import('../pendingItemOutbox')
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
              '[bsv21-send] peer notification queued',
              error instanceof Error ? error.message : String(error),
            )
          }
        })()
      }

      setPaymentProgress('broadcasting', 'Broadcasting token transfer', primary.outpoint)
      const spent = selected.map((t) => normalizeOutpoint(t.outpoint))
      const payeeIsSelf =
        args.toAddress.trim().toLowerCase() === wallet.address.trim().toLowerCase()
      markItemsSent([
        ...spent.map((outpoint) => ({ outpoint, txid })),
        ...(payeeIsSelf
          ? []
          : payeeOutpoints.map((outpoint) => ({
              outpoint,
              txid,
              settle: 'senderBroadcast' as const,
            }))),
      ])
      if (!payeeIsSelf) {
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
      scheduleHistoryBackupPush('sendBsv21Tokens')
      // Exactly like a BSV payment: Activity owns the signed cheque before
      // background propagation can report a late hard rejection.
      startSignedSendPropagation(signedSend, {
        pendingId: outboundPending.id,
      })
      const { paintFungibleAfterSpend, getFungible } = await import('./list')
      paintFungibleAfterSpend({
        tokenId,
        remainingAmt,
        outpoint: remainingOp,
        sym,
        icon: args.icon,
        dec: getFungible(tokenId)?.dec ?? 0,
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
          await import('../actionReview')
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
export async function combineBsv21Tips(args: {
  tokenId: string
  sym?: string
}): Promise<{ txid: string; tipsSpent: number }> {
  const tokenId = requireTokenId(args.tokenId)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const listed162 = await listBsv21BinaryTips(active)
  const mine = listed162.filter((t) => t.tokenId === tokenId)
  if (mine.length < 2) {
    throw new Error('Already a single tip — nothing to combine')
  }
  const amount = mine.reduce((s, t) => s + Number(t.amt.replace(/\D/g, '') || '0'), 0)
  const result = await sendBsv21Tokens({
    tokenId,
    amount,
    toAddress: active.address,
    skipPeerNotify: true,
    sym: args.sym,
    actionDescription: 'Combine token tips',
    actionLabel: 'handcash-combine-bsv21',
  })
  return { txid: result.txid, tipsSpent: result.tipsSpent }
}
