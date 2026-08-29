/**
 * Send 1Sat fungibles (BRC-175): spend tip(s), emit payee (+ change) 1-sat tips
 * with conserved face-value `amt`. Dust/fees from ordinary BSV.
 *
 * Combine = spend all tips for an origin into one self tip (same path, no peer).
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import {
  assertColourAmtConservation,
  buildColourCustomInstructions,
  issuerFromColourTags,
  ONESAT_FT_BASKET,
  colourTags,
  normalizeColourOrigin,
  selectColourTipsForAmount,
  tipFaceAmt,
  type ColourTip,
} from './colourCoins'
import { listColourTipsForOrigin, listColourTokens } from './colourListing'
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
import { normalizeOutpoint } from './collectables'
import { scheduleHistoryBackupPush } from './deviceSync'
import { listFriends, resolvePaymentRecipient } from './friends'
import { stampBrc164Id } from './itemAccess'
import { buildOnesatFtTransferLockingScript } from './onesatFtInscribe'
import { isCovenantLockedScript } from './collectableTipKind'
import { tryBuildProvenanceForSend } from './oneSatProvenance'
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

function wireOutpoint(op: string): string {
  return op.includes('_') ? op.replace(/_(\d+)$/, '.$1') : op
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
        console.warn('[1sat-ft] source tx hydrate failed', input.sourceTXID, err)
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

  const listed = args.tips ?? (await listColourTipsForOrigin(origin, active))
  let selected: ColourTip[]
  let change: number
  let amount: number
  if (args.tips?.length) {
    selected = args.tips.filter((t) => t.satoshis === 1 && t.proven)
    if (selected.length === 0) throw new Error('No spendable tips')
    const selectedSum = selected.reduce((s, t) => s + tipFaceAmt(t), 0)
    amount = args.amount
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('Amount must be a positive whole number of units')
    }
    if (amount > selectedSum) {
      throw new Error(`Need ${amount} units; only ${selectedSum} in selected tips`)
    }
    change = selectedSum - amount
  } else {
    const cover = selectColourTipsForAmount(listed, args.amount)
    selected = cover.selected
    change = cover.change
    amount = cover.amount
  }
  assertColourAmtConservation(
    selected.map(tipFaceAmt),
    change > 0 ? [amount, change] : [amount],
  )
  const sym = args.sym?.trim() || 'Token'
  const primary = selected[0]!
  const actionLabel = args.actionLabel ?? 'handcash-send-1sat-ft'
  const actionDescription = args.actionDescription ?? 'Send 1Sat token'

  setPaymentProgress(
    'preparing',
    args.skipPeerNotify ? 'Waiting to combine tips' : 'Waiting to send token',
    primary.outpoint,
  )
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
        // Stuck noSend from a prior hang leaves TaskSendWaiting + reserved
        // funding — the next createAction then sits forever. Clear both first.
        const {
          abortReservedActionBatches,
          releaseStuckNosends,
        } = await import('./actionReview')
        await releaseStuckNosends(wallet)
        await abortReservedActionBatches(wallet)
      }

      setPaymentProgress(
        'building',
        args.skipPeerNotify ? 'Combining tips…' : 'Preparing 1Sat tip…',
        primary.outpoint,
      )
      const to = await resolvePaymentRecipient(args.toAddress, wallet.chain)
      let payeeLock: string
      let changeLock: string
      try {
        payeeLock = buildOnesatFtTransferLockingScript({
          address: to,
          amt: amount,
        }).lockingScript
        changeLock =
          change > 0
            ? buildOnesatFtTransferLockingScript({
                address: wallet.address,
                amt: change,
              }).lockingScript
            : new P2PKH().lock(wallet.address).toHex()
      } catch {
        throw new Error('Invalid recipient address or identity key')
      }

      const peerKey =
        args.skipPeerNotify
          ? null
          : args.recipientIdentityKey?.trim().toLowerCase() || null
      const parentRef = primary.outpoint
      const spendOutpoints = selected.map((tip) => wireOutpoint(tip.outpoint))
      const knownTxids = [
        ...new Set(
          spendOutpoints
            .map((op) => op.split('.')[0]?.toLowerCase())
            .filter((txid): txid is string => Boolean(txid)),
        ),
      ]

      // Same as collectables: feed tip BEEF + trustSelf so createAction does not
      // block on chainTracker for a freshly minted (still-unconfirmed) tip.
      setPaymentProgress(
        'building',
        'Loading tip proofs…',
        primary.outpoint,
      )
      let inputBEEF: number[]
      try {
        inputBEEF = await buildMergedInputBeef(
          wallet,
          spendOutpoints,
          wireOutpoint,
        )
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? err.message.replace(/collectable/i, 'token tip')
            : 'Could not load the transaction that holds this token tip. Refresh, then send again.',
        )
      }

      const provenance = await tryBuildProvenanceForSend({
        tipOutpoint: wireOutpoint(primary.outpoint),
        origin,
        wallet,
        priorProvenance: primary.provenance,
        inputBeef: inputBEEF,
      })
      const issuer = (() => {
        for (const tip of selected) {
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
      const tags = stampBrc164Id(
        colourTags(origin, [
          `name:${sym.slice(0, 80)}`,
          ...(args.icon ? [`icon:${args.icon}`] : []),
          ...(issuer ? [`issuer:${issuer}`] : []),
        ]),
      )
      const baseCi = {
        origin,
        sym,
        name: sym,
        supply: args.supply,
        maxSupply: args.maxSupply ?? null,
        provenance: provenance ?? primary.provenance ?? null,
        parent: parentRef,
        ...(args.icon ? { icon: args.icon } : {}),
        ...(issuer ? { issuer } : {}),
      }

      const outputs: Array<{
        lockingScript: string
        satoshis: number
        outputDescription: string
        basket: string
        tags: string[]
        customInstructions: string
      }> = [
        {
          lockingScript: payeeLock,
          satoshis: 1,
          outputDescription: args.skipPeerNotify ? '1Sat combined tip' : '1Sat tip',
          basket: ONESAT_FT_BASKET,
          tags,
          customInstructions: buildColourCustomInstructions({
            ...baseCi,
            amt: amount,
          }),
        },
      ]
      if (change > 0) {
        outputs.push({
          lockingScript: changeLock,
          satoshis: 1,
          outputDescription: '1Sat change',
          basket: ONESAT_FT_BASKET,
          tags,
          customInstructions: buildColourCustomInstructions({
            ...baseCi,
            amt: change,
          }),
        })
      }

      setPaymentProgress(
        'signing',
        args.skipPeerNotify ? 'Signing combined tip…' : 'Signing 1Sat tip…',
        primary.outpoint,
      )
      console.info(
        `[1sat-ft] createAction start tips=${selected.length} amount=${amount} change=${change}`,
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
              inputDescription: '1Sat tip',
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
            labels: [ONESAT_FT_BASKET, actionLabel],
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
                inputDescription: '1Sat tip',
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
              labels: [ONESAT_FT_BASKET, actionLabel],
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
        console.info('[1sat-ft] createAction returned signable — unlocking tip(s)')
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
      console.info(`[1sat-ft] createAction done txid=${txid}`)

      if (!atomic?.length) {
        try {
          const beef = await getBeefForTxidCached(wallet, txid, { needProof: true })
          atomic = Array.from(beef.toBinaryAtomic(txid))
        } catch {
          try {
            const wrap = Beef.fromBinary(
              Array.from((await getBeefForTxidCached(wallet, txid, { needProof: true })).toBinary()),
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
        await notifyPeerItemIncoming({
          recipientIdentityKey: peerKey,
          rootKeyHex: wallet.rootKeyHex,
          senderIdentityKey: wallet.identityKey,
          messagebox: friend?.messagebox,
          txid,
          itemName: sym,
          asset: {
            kind: '1sat-ft',
            origin,
            amount: String(amount),
            sym,
            ...(args.supply ? { supply: args.supply } : {}),
            ...(args.maxSupply != null ? { maxSupply: args.maxSupply } : {}),
          },
          atomicBeef: atomic,
        })
      }

      setPaymentProgress('broadcasting', 'Broadcasting token transfer', primary.outpoint)
      const ok = await broadcastAtomicBeef(txid, atomic)
      if (!ok) {
        await releaseSealedInputsOfUnsentTx(txid, atomic)
        throw new Error('Token transfer was not accepted by the network')
      }

      const spent = selected.map((t) => normalizeOutpoint(t.outpoint))
      markItemsSent(spent.map((outpoint) => ({ outpoint, txid })))
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
      const selectedSum = selected.reduce((s, tip) => s + tipFaceAmt(tip), 0)
      const kept =
        change > 0 ? change : args.skipPeerNotify ? amount : Math.max(0, selectedSum - amount)
      const keptOp =
        change > 0 ? `${txid}_1` : args.skipPeerNotify ? `${txid}_0` : undefined
      void Promise.all([import('./fungibles'), import('./onesatFtLeftover')])
        .then(([{ paintFungibleAfterSpend }, { rememberOnesatFtLeftover, forgetOnesatFtLeftover }]) => {
          paintFungibleAfterSpend({
            tokenId: origin,
            remainingAmt: kept,
            outpoint: keptOp,
            sym,
            colourSupply: args.supply,
            colourMaxSupply: args.maxSupply ?? null,
            icon: args.icon,
          })
          if (kept > 0 && keptOp) {
            rememberOnesatFtLeftover({
              origin,
              amt: kept,
              outpoint: keptOp,
              ci: buildColourCustomInstructions({
                origin,
                amt: kept,
                sym,
                supply: args.supply,
                maxSupply: args.maxSupply ?? null,
                issuer,
              }),
              sym,
              supply: args.supply,
              maxSupply: args.maxSupply ?? null,
            })
          } else {
            forgetOnesatFtLeftover(origin)
          }
        })
        .catch(() => {})
      return { txid, tipsSpent: selected.length, change }
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
          'building',
          args.skipPeerNotify ? 'Combining tips…' : 'Preparing 1Sat tip…',
          primary.outpoint,
        )
      },
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
        void listColourTokens(active).catch(() => {})
      }
    } catch (recoverErr) {
      console.warn('[1sat-ft] tip restore after failed send skipped', recoverErr)
    }
    throw err
  }
}

/** Fold all bound tips for an origin into one self tip (balance unchanged). */
export async function combineColourTips(args: {
  origin: string
  sym?: string
  supply?: 'locked' | 'open'
  maxSupply?: number | null
}): Promise<{ txid: string; tipsSpent: number }> {
  const origin = normalizeColourOrigin(args.origin)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const tips = (await listColourTipsForOrigin(origin, active)).filter(
    (t) => t.satoshis === 1 && t.proven,
  )
  if (tips.length < 2) {
    throw new Error('Already a single tip — nothing to combine')
  }
  const amount = tips.reduce((s, t) => s + tipFaceAmt(t), 0)
  const result = await sendColourCoins({
    origin,
    amount,
    toAddress: active.address,
    tips,
    skipPeerNotify: true,
    sym: args.sym,
    supply: args.supply,
    maxSupply: args.maxSupply ?? null,
    actionDescription: 'Combine 1Sat tips',
    actionLabel: 'handcash-combine-1sat-ft',
  })
  return { txid: result.txid, tipsSpent: result.tipsSpent }
}
