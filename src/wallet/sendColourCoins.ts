/**
 * Send 1Sat fungibles (BRC-175): spend tip(s), emit payee (+ change) 1-sat tips
 * with conserved face-value `amt`. Dust/fees from ordinary BSV.
 *
 * Combine = spend all tips for an origin into one self tip (same path, no peer).
 */
import { Beef, P2PKH } from '@bsv/sdk'
import {
  assertColourAmtConservation,
  buildColourCustomInstructions,
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
import { getBeefForTxidCached, rememberBeefTree } from './beefCache'
import { normalizeOutpoint } from './collectables'
import { scheduleHistoryBackupPush } from './deviceSync'
import { listFriends, resolvePaymentRecipient } from './friends'
import { stampBrc164Id } from './itemAccess'
import { tryBuildProvenanceForSend } from './oneSatProvenance'
import { assertOnlineForPayment } from './paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from './paymentProgress'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet } from './session'
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
    return await runExclusiveSpend(async () => {
      assertOnlineForPayment()
      const wallet = getActiveWallet()
      if (!wallet) throw new Error('Wallet locked')
      {
        const { abortReservedActionBatches } = await import('./actionReview')
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
        payeeLock = new P2PKH().lock(to).toHex()
        changeLock = new P2PKH().lock(wallet.address).toHex()
      } catch {
        throw new Error('Invalid recipient address or identity key')
      }

      const peerKey =
        args.skipPeerNotify
          ? null
          : args.recipientIdentityKey?.trim().toLowerCase() || null
      const parentRef = primary.outpoint
      const provenance = await tryBuildProvenanceForSend({
        tipOutpoint: wireOutpoint(primary.outpoint),
        origin,
        wallet,
        priorProvenance: primary.provenance,
      })
      const tags = stampBrc164Id(colourTags(origin, [`name:${sym.slice(0, 80)}`]))
      const baseCi = {
        origin,
        sym,
        name: sym,
        supply: args.supply,
        maxSupply: args.maxSupply ?? null,
        provenance: provenance ?? primary.provenance ?? null,
        parent: parentRef,
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

      const created = await wallet.wallet.createAction({
        description: actionDescription,
        inputs: selected.map((tip) => ({
          outpoint: wireOutpoint(tip.outpoint),
          inputDescription: '1Sat tip',
          unlockingScriptLength: 108,
        })),
        outputs,
        options: {
          noSend: true,
          randomizeOutputs: false,
          signAndProcess: true,
        },
        labels: [ONESAT_FT_BASKET, actionLabel],
      })

      const txid =
        typeof created.txid === 'string' && /^[0-9a-f]{64}$/i.test(created.txid)
          ? created.txid.toLowerCase()
          : ''
      if (!txid) throw new Error('Token transfer produced no txid')

      let atomic = atomicBeefFromWalletResult(created)
      if (!atomic?.length) {
        try {
          const beef = await getBeefForTxidCached(wallet, txid)
          atomic = Array.from(beef.toBinaryAtomic(txid))
        } catch {
          try {
            const wrap = Beef.fromBinary(
              Array.from((await getBeefForTxidCached(wallet, txid)).toBinary()),
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

      if (peerKey) {
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
            kind: 'onesat-ft',
            origin,
            amount: String(amount),
            sym,
            ...(args.supply ? { supply: args.supply } : {}),
            ...(args.maxSupply != null ? { maxSupply: args.maxSupply } : {}),
          },
          atomicBeef: atomic,
        })
      }

      await broadcastAtomicBeef(txid, atomic)

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
      void listColourTokens(wallet).catch(() => {})
      return { txid, tipsSpent: selected.length, change }
    })
  } catch (err) {
    clearPendingSend(outboundPending.id)
    failOutboundSendPending({
      pendingId: outboundPending.id,
      reason: err instanceof Error ? err.message : String(err),
    })
    clearPaymentProgress()
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
