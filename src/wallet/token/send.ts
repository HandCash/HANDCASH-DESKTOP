import { getActiveWallet } from '../session'
import { accountKeyScopeFor } from '../accountLocalKeys'

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
import { retainTokenGenesis } from './genesisStore'
import { chainTrackerFor, recordProvenTokenTips, tokenLineageFromBeef } from './lineage'
import {
  type Bsv21SendPath,
  type Bsv21TipKind,
  chooseBsv21BatchSendPath,
  classifyBsv21TipKind,
} from './tipKind'
import { interpretBsv21SendPath } from './sendMachine'
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
  EMPTY_INPUT_BEEF,
  describeInputBeefFrame,
  isInputBeefRefusal,
  verifiableInputBeef,
} from './verifiableInputBeef'
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
import { signTipInputs } from '../signTipInputs'
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
 * BRC-163: a value tip whose rest script is not plain P2PKH fails closed before
 * createAction reserves anything, not at unlock time. Every selected input is
 * classified as one batch: cosigner, covenant or an unknown lock is a named
 * refusal, never a P2PKH unlock attempt.
 */
export function chooseBsv21ValueTipPath(
  tips: ReadonlyArray<Pick<Bsv21SendTip, 'lockingScript'>>,
): Bsv21SendPath {
  return chooseBsv21BatchSendPath(
    tips.map((tip): Bsv21TipKind => {
      const rest = tip.lockingScript
        ? decodeBsv21Binary(tip.lockingScript)?.restScriptHex
        : undefined
      if (!rest) return { kind: 'unknown' }
      const kind = classifyBsv21TipKind({ lockingScript: rest })
      // The covenant matcher also matches a cosigner suffix; it only vetoes plain.
      return kind.kind === 'plain' && isCovenantLockedScript(rest) ? { kind: 'unknown' } : kind
    }),
  )
}

/** Every tip outpoint the cached card of this token shows. */
async function cardTipOutpoints(tokenId: string): Promise<Set<string>> {
  const { getCachedFungibles } = await import('./list')
  const outpoints = new Set<string>()
  for (const token of getCachedFungibles()) {
    if (normalizeTokenId(token.tokenId) !== tokenId) continue
    if (token.outpoint) outpoints.add(token.outpoint)
    for (const outpoint of token.tipOutpoints ?? []) outpoints.add(outpoint)
    for (const tip of token.heldTips ?? []) outpoints.add(tip.outpoint)
  }
  return outpoints
}

/**
 * A mint that never got a locking script on listOutputs still has the 162
 * body in local BEEF. Spend that — do not wait for an indexer to rewrite it.
 */
export async function recoverBsv21TipsFromLocalBeef(
  wallet: ActiveWallet,
  tokenId: string,
): Promise<Bsv21SendTip[]> {
  const {
    getLocalBeefForTxid,
    peekSessionBeef,
    getBeefForTxidCached,
  } = await import('../beefCache')
  const { restoreUnspentAssetOutpoint } = await import('../staleOutputRelease')
  const { isItemSent } = await import('../sentItemGuard')
  const want = requireTokenId(tokenId)
  const tips: Bsv21SendTip[] = []
  for (const op of await cardTipOutpoints(want)) {
    const wire = wireOutpoint(op)
    if (isItemSent(wire)) continue
    const [txid, voutRaw] = wire.split('.')
    if (!txid) continue
    // Prefer live toolbox / local bodies. A display-cache tip that is already
    // spent (e.g. the tip we just sold on the market) must not become a burn
    // input — that surfaced as "action batch outputs are no longer spendable".
    if (!(await restoreUnspentAssetOutpoint(wallet, wire))) continue
    let hex =
      (await getLocalBeefForTxid(wallet, txid))
        ?.findTxid(txid.toLowerCase())
        ?.tx?.outputs?.[Number(voutRaw)]
        ?.lockingScript?.toHex() ??
      peekSessionBeef(txid)
        ?.findTxid(txid.toLowerCase())
        ?.tx?.outputs?.[Number(voutRaw)]
        ?.lockingScript?.toHex()
    if (!hex) {
      try {
        const beef = await getBeefForTxidCached(wallet, txid, {
          allowUnprovenRawTx: true,
        })
        hex = beef
          .findTxid(txid.toLowerCase())
          ?.tx?.outputs?.[Number(voutRaw)]
          ?.lockingScript?.toHex()
      } catch {
        continue
      }
    }
    if (!hex) continue
    const decoded = tipFromBsv21Script({
      outpoint: wire,
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
      `[bsv21] recovered ${tips.length} tip(s) from cached BEEF (listOutputs had no 162 lock)`,
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
  const spends = await signTipInputs(unsigned, vins)

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
  amount: number | bigint
  toAddress: string
  friendLabel?: string | null
  recipientIdentityKey?: string | null
  sym?: string
  /**
   * Display decimals from the deploy. Carried into child remittance, the
   * Activity row and the peer envelope (BRC-163 `dec`); when omitted the
   * cached card supplies it.
   */
  dec?: number
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
}): Promise<{ txid: string; tipsSpent: number; change: bigint }> {
  const tokenId = requireTokenId(args.tokenId)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const tipsStartedAt = Date.now()
  let listed162 = await listBsv21BinaryTips(active, {
    includeCustomInstructions: false,
  })
  const tipsOfToken = (listed: typeof listed162): Bsv21SendTip[] =>
    listed
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
  let fromBasket = tipsOfToken(listed162)
  let listedForToken = fromBasket.length
  if (fromArgs.length === 0 && fromBasket.length === 0) {
    fromBasket.push(...(await recoverBsv21TipsFromLocalBeef(active, tokenId)))
  }
  let claimedNote = ''
  const covered = fromBasket.reduce((sum, t) => sum + t.amt, 0n)
  if (fromArgs.length === 0 && covered < BigInt(args.amount)) {
    // The card can show a tip no row holds (a send whose storage write was
    // dropped). Only the reconcile's chain-proven claim makes it spendable.
    const have = new Set(fromBasket.map((t) => wireOutpoint(t.outpoint)))
    const shownOnly = [...(await cardTipOutpoints(tokenId))]
      .map(wireOutpoint)
      .filter((op) => !have.has(op))
    if (shownOnly.length > 0) {
      const { reconcileNow } = await import('../holdingsReconcile')
      await reconcileNow('token', shownOnly)
      listed162 = await listBsv21BinaryTips(active, {
        includeCustomInstructions: false,
      })
      const after = tipsOfToken(listed162)
      if (after.length > listedForToken) {
        claimedNote = `, claimed ${after.length - listedForToken} shown-only tip(s)`
        fromBasket = after
        listedForToken = after.length
      } else {
        // A claimed row can list without its 162 lock. The row now exists, so
        // the local-BEEF recovery that refused it before the claim can read
        // the lock from the transaction this wallet signed.
        const held = new Set(fromBasket.map((t) => wireOutpoint(t.outpoint)))
        const recovered = (await recoverBsv21TipsFromLocalBeef(active, tokenId)).filter(
          (t) => !held.has(wireOutpoint(t.outpoint)),
        )
        fromBasket = [...fromBasket, ...recovered]
        claimedNote = recovered.length
          ? `, ${recovered.length} shown-only tip(s) read from local BEEF after the claim`
          : `, ${shownOnly.length} shown-only tip(s) not claimed`
      }
    }
  }
  const tipsMs = Date.now() - tipsStartedAt
  if (tipsMs >= 250 || claimedNote) {
    console.info(
      `[bsv21] send tips done ${tipsMs}ms — listed ${listedForToken}, recovered ${fromBasket.length - listedForToken}${claimedNote}`,
    )
  }
  const plan = planBsv21Send({
    tokenId,
    amount: BigInt(args.amount),
    tips: fromArgs.length ? fromArgs : fromBasket,
  })
  const selected = plan.selected
  const change = plan.changeAmt
  const amount = plan.payeeAmt
  console.info(
    `[bsv21] send plan tips=${selected.length} amount=${amount} change=${change} token=${tokenId.slice(0, 16)}`,
  )
  const lockVerdict = interpretBsv21SendPath(tokenId, chooseBsv21ValueTipPath(selected))
  if (!lockVerdict.allowed) {
    const reason = lockVerdict.error ?? 'unknown_lock'
    console.warn(`[bsv21] send refused before sign: ${reason}`)
    throw new Error(
      reason === 'cosigner_required'
        ? 'This token requires a cosigner to spend; HandCash cannot sign it alone yet.'
        : reason === 'mixed_tips'
          ? 'These token tips have different lock types and cannot be spent together.'
          : 'A selected token tip uses a lock this wallet cannot spend.',
    )
  }
  const sym = args.sym?.trim() || 'Token'
  const dec = await (async () => {
    const isDec = (n: unknown): n is number =>
      Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 18
    if (isDec(args.dec)) return args.dec
    const { getFungible } = await import('./list')
    const cached = getFungible(tokenId)?.dec
    if (isDec(cached)) return cached
    const fromTip = listed162.find((t) => t.tokenId === tokenId && isDec(t.dec) && t.dec > 0)?.dec
    return isDec(fromTip) ? fromTip : 0
  })()
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
    dec,
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
      // Resolved, not typed: a handle that resolves to this wallet is a
      // self-send too. Self outputs stay in basket `bsv21` (BRC-163).
      const payeeIsSelf =
        to.trim().toLowerCase() === wallet.address.trim().toLowerCase()
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
          dec,
          issuer,
          icon,
          payeeIsSelf,
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
          inputBEEF = await mergeLocalUnconfirmedAncestry(wallet, beef.toBinary())
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
      const frame = verifiableInputBeef(inputBEEF)
      if (frame.dropped.length > 0) {
        console.info(`[bsv21] inputBEEF framed — ${describeInputBeefFrame(frame)}`)
      }
      const createTransfer = (packaged: number[]) =>
        withFungibleCreateActionTimeout(
          wallet.wallet.createAction({
            description: actionDescription,
            inputBEEF: packaged,
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
      const createWithReservedRetry = async (packaged: number[]) => {
        try {
          return await createTransfer(packaged)
        } catch (err) {
          const { isReservedActionBatchError, abortReservedActionBatches } =
            await import('../actionReview')
          if (!isReservedActionBatchError(err)) throw err
          await abortReservedActionBatches(wallet)
          return await createTransfer(packaged)
        }
      }
      let actionReference: string | undefined
      try {
      let created: Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>
      try {
        created = await createWithReservedRetry(frame.inputBEEF)
      } catch (err) {
        if (!isInputBeefRefusal(err) || frame.inputBEEF === EMPTY_INPUT_BEEF) throw err
        // Structure is already proven above, so a proof root the chain tracker
        // would not confirm refused it; storage-held tips need no caller proof.
        console.warn(
          `[bsv21] inputBEEF refused by the chain tracker — ${describeInputBeefFrame(frame)}; signing from storage-held tips`,
        )
        created = await createWithReservedRetry(EMPTY_INPUT_BEEF)
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
      /** Every output this wallet still holds after the spend (self payee + change). */
      let heldAfter: { outpoint: string; amt: bigint }[] = []
      let tokenLineage: number[] | null = null
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
          heldAfter = [
            ...(payeeIsSelf ? classified.payee : []),
            ...classified.change,
          ].map((out) => ({ outpoint: `${txid}_${out.vout}`, amt: out.amt }))
          remainingAmt = heldAfter.reduce((sum, out) => sum + out.amt, 0n)
          remainingOp = heldAfter[0]?.outpoint
          payeeOutpoints = classified.payee.map((out) => `${txid}_${out.vout}`)
          console.info(
            `[bsv21] signed outputs payee=${classified.payee.map((o) => `${o.vout}:${o.amt}`).join(',') || 'none'} change=${classified.change.map((o) => `${o.vout}:${o.amt}`).join(',') || 'none'}`,
          )
          const { beef: proved } = buildBsv21SubjectBeef({
            parentBeef: withParents,
            subjectTx: signedTx,
          })
          tokenLineage = tokenLineageFromBeef(withParents, txid, tokenId)
          const deployOutpoint = recordProvenTokenTips(
            withParents,
            heldAfter.map((out) => out.outpoint),
            tokenId,
          )
          if (deployOutpoint) {
            void chainTrackerFor(wallet)
              .then((tracker) =>
                retainTokenGenesis(withParents, deployOutpoint.split('_')[0]!, tracker),
              )
              .catch(() => false)
          }
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
          dec,
          ...(icon ? { icon } : {}),
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
              ...(tokenLineage ? { tokenLineage } : {}),
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
            }, accountKeyScopeFor(wallet))
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
            }, accountKeyScopeFor(wallet))
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
      markItemsSent([
        ...spent.map((outpoint) => ({ outpoint, txid, asset: 'token' as const })),
        ...(payeeIsSelf
          ? []
          : payeeOutpoints.map((outpoint) => ({
              outpoint,
              txid,
              settle: 'senderBroadcast' as const,
              asset: 'token' as const,
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
      const { paintFungibleAfterSpend } = await import('./list')
      paintFungibleAfterSpend({
        tokenId,
        remainingAmt,
        outpoint: remainingOp,
        sym,
        icon,
        dec,
        binarySupply: 'locked',
        ...(heldAfter.length > 1
          ? {
              utxoCount: heldAfter.length,
              heldTips: heldAfter.map((out) => ({
                outpoint: out.outpoint,
                tokenId,
                amt: out.amt.toString(),
                op: 'transfer' as const,
                sym,
                dec,
                satoshis: 1,
                binarySupply: 'locked' as const,
                encoding: 'brc162' as const,
                ...(icon ? { icon } : {}),
                seenAt: Date.now(),
              })),
            }
          : {}),
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
  const mine = listed162.filter(
    (t) =>
      t.tokenId === tokenId && !!t.lockingScript && !!decodeBsv21Binary(t.lockingScript),
  )
  if (mine.length < 2) {
    console.warn(
      `[bsv21] combine refused — basket holds ${mine.length} spendable tip(s) of ${tokenId.slice(0, 16)}`,
    )
    throw new Error('Already a single tip — nothing to combine')
  }
  // Exact units: a Number sum rounds past 2^53 and asks the plan for more than is held.
  const amount = mine.reduce((s, t) => s + BigInt(t.amt.replace(/\D/g, '') || '0'), 0n)
  const dec = mine.find((t) => t.dec > 0)?.dec
  const icon = mine.find((t) => t.icon)?.icon
  console.info(`[bsv21] combine start tips=${mine.length} token=${tokenId.slice(0, 16)}`)
  try {
    const result = await sendBsv21Tokens({
      tokenId,
      amount,
      toAddress: active.address,
      tips: mine.map((t) => ({
        outpoint: t.outpoint,
        tokenId: t.tokenId,
        amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
        lockingScript: t.lockingScript,
      })),
      skipPeerNotify: true,
      sym: args.sym ?? mine.find((t) => t.sym)?.sym,
      ...(dec != null ? { dec } : {}),
      ...(icon ? { icon } : {}),
      actionDescription: 'Combine token tips',
      actionLabel: 'handcash-combine-bsv21',
    })
    console.info(`[bsv21] combine done ${result.txid.slice(0, 12)} — ${result.tipsSpent} tip(s) → 1`)
    return { txid: result.txid, tipsSpent: result.tipsSpent }
  } catch (err) {
    console.warn(
      `[bsv21] combine failed — ${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}
