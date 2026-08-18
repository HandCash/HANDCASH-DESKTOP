/**
 * Wallet-native BSV-21 fungible send — synonymous with {@link sendCollectable}.
 *
 * Selects tips by token id, builds inscribed transfer (+ change) outputs,
 * settles via the same peerDeliver / selfReceive / externalBroadcast path as
 * items, and refuses cosigned / unknown locks without a cosigner client.
 */
import { Beef } from '@bsv/sdk'
import { createActor } from 'xstate'
import {
  buildBsv21CustomInstructions,
  BSV21_BASKET,
  bsv21Tags,
  chooseBsv21SendPath,
  classifyBsv21TipKind,
  formatFungibleAmount,
  normalizeTokenId,
  type Bsv21Utxo,
  type FungibleToken,
} from './bsv21'
import { buildBsv21TransferLockingScript } from './bsv21Inscribe'
import { bsv21SendMachine } from './bsv21SendMachine'
import {
  failOutboundSendPending,
  noteOutboundSendComplete,
  noteOutboundSendPending,
  type ActivityItem,
} from './appActivity'
import { rememberBeefTree } from './beefCache'
import { scheduleHistoryBackupPush } from './deviceSync'
import { listFriends, resolvePaymentRecipient } from './friends'
import {
  getCachedFungibles,
  getFungible,
  listFungibleTips,
  listFungibles,
} from './fungibles'
import { stampBrc164Id } from './itemAccess'
import {
  isSilentSenderBroadcast,
  itemSendMachine,
  maySenderBroadcast,
  mustDeliverToPeer,
} from './itemSendMachine'
import { chooseItemSettlePath, type ItemSettlePath } from './itemSettlePath'
import { scriptPaysAddress } from './ordinalOwnership'
import { assertOnlineForPayment } from './paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from './paymentProgress'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet, type ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'

function atomicBeefFromWalletResult(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return undefined
}

function wireOutpoint(op: string): string {
  const t = op.trim().toLowerCase()
  return t.includes('.') ? t : t.replace(/_(\d+)$/, '.$1')
}

function parseDisplayAmount(raw: string, dec: number): bigint {
  const trimmed = raw.trim().replace(/,/g, '')
  if (!trimmed) throw new Error('Enter an amount')
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Invalid amount')
  const [wholeRaw, fracRaw = ''] = trimmed.split('.')
  if (fracRaw.length > dec) {
    throw new Error(
      dec === 0
        ? 'This token has no decimal places'
        : `At most ${dec} decimal place${dec === 1 ? '' : 's'}`,
    )
  }
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const frac = fracRaw.padEnd(dec, '0')
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, '') || '0'
  const n = BigInt(digits)
  if (n <= 0n) throw new Error('Amount must be greater than zero')
  return n
}

export function parseFungibleSendAmount(
  raw: string,
  token: Pick<FungibleToken, 'dec' | 'amt'>,
): { units: bigint; unitsStr: string } {
  const units = parseDisplayAmount(raw, token.dec)
  const held = BigInt(token.amt.replace(/\D/g, '') || '0')
  if (units > held) {
    throw new Error(
      `Insufficient balance (have ${formatFungibleAmount(token.amt, token.dec)})`,
    )
  }
  return { units, unitsStr: units.toString() }
}

/** Greedy largest-first selection until `need` units are covered. */
export function selectFungibleTips(
  tips: Bsv21Utxo[],
  need: bigint,
): { selected: Bsv21Utxo[]; selectedSum: bigint } {
  const sorted = [...tips].sort((a, b) => {
    const da = BigInt(a.amt.replace(/\D/g, '') || '0')
    const db = BigInt(b.amt.replace(/\D/g, '') || '0')
    return db > da ? 1 : db < da ? -1 : 0
  })
  const selected: Bsv21Utxo[] = []
  let selectedSum = 0n
  for (const tip of sorted) {
    if (selectedSum >= need) break
    const amt = BigInt(tip.amt.replace(/\D/g, '') || '0')
    if (amt <= 0n) continue
    selected.push(tip)
    selectedSum += amt
  }
  if (selectedSum < need) {
    throw new Error('Not enough token outputs to cover this send')
  }
  return { selected, selectedSum }
}

function refuseReasonMessage(reason: string): string {
  switch (reason) {
    case 'cosigner_required':
      return 'This token requires a cosigner to send. Cosigner send is not available in the wallet yet.'
    case 'unknown_lock':
      return 'This token tip has an unrecognized lock and cannot be sent.'
    case 'mixed_tips':
      return 'This balance mixes plain and cosigned tips — send them separately.'
    default:
      return reason
  }
}

async function relinquishTips(
  wallet: ActiveWallet,
  outpoints: string[],
): Promise<void> {
  for (const op of outpoints) {
    try {
      await wallet.wallet.relinquishOutput({
        basket: BSV21_BASKET,
        output: wireOutpoint(op),
      } as never)
    } catch {
      // createAction often already spent them; list refresh heals.
    }
  }
}

export async function sendFungible(args: {
  tokenId: string
  /** Display amount (with decimals) or integer token units. */
  amount: string
  toAddress: string
  recipientIdentityKey?: string | null
  friendLabel?: string | null
}): Promise<{ txid: string }> {
  const tokenId = normalizeTokenId(args.tokenId) ?? args.tokenId.trim().toLowerCase()
  const token =
    getFungible(tokenId) ??
    getCachedFungibles().find(
      (t) => t.tokenId === tokenId || t.tokenIds?.includes(tokenId),
    )
  if (!token) throw new Error('Token not found in this wallet')

  const { unitsStr } = /^\d+$/.test(args.amount.trim())
    ? (() => {
        const units = BigInt(args.amount.trim())
        if (units <= 0n) throw new Error('Amount must be greater than zero')
        const held = BigInt(token.amt.replace(/\D/g, '') || '0')
        if (units > held) {
          throw new Error(
            `Insufficient balance (have ${formatFungibleAmount(token.amt, token.dec)})`,
          )
        }
        return { unitsStr: units.toString() }
      })()
    : parseFungibleSendAmount(args.amount, token)

  const activityItem: ActivityItem = {
    name: token.sym,
    origin: token.tokenId,
    tokenId: token.tokenId,
    amt: unitsStr,
    dec: token.dec,
    outpoint: token.outpoint,
    ...(token.iconUrl ? { imageUrl: token.iconUrl } : {}),
    ...(token.icon ? { icon: token.icon } : {}),
  }

  setPaymentProgress('preparing', `Waiting to send ${token.sym}`, token.outpoint)
  const outboundPending = beginPendingSend({
    to: args.toAddress,
    sats: 1,
    friendLabel: args.friendLabel ?? null,
  })
  noteOutboundSendPending({
    pendingId: outboundPending.id,
    sats: 1,
    to: args.toAddress,
    friendLabel: args.friendLabel ?? null,
    recipientIdentityKey: args.recipientIdentityKey ?? null,
    item: activityItem,
  })

  const failSend = (err: unknown): never => {
    clearPendingSend(outboundPending.id)
    const message = err instanceof Error ? err.message : String(err)
    failOutboundSendPending({
      pendingId: outboundPending.id,
      reason: message,
    })
    clearPaymentProgress()
    throw err instanceof Error ? err : new Error(message)
  }

  try {
    return await runExclusiveSpend(async () => {
      try {
        assertOnlineForPayment()
        const wallet = getActiveWallet()
        if (!wallet) throw new Error('Wallet locked')
        {
          const { abortReservedActionBatches } = await import('./actionReview')
          await abortReservedActionBatches(wallet)
        }

        setPaymentProgress(
          'building',
          `Preparing ${token.sym} for transfer`,
          token.outpoint,
        )
        const to = await resolvePaymentRecipient(args.toAddress, wallet.chain)

        if (token.spendKind === 'mixed') {
          return failSend(new Error(refuseReasonMessage('mixed_tips')))
        }

        const tips = await listFungibleTips(wallet, {
          tokenIds: token.tokenIds ?? [token.tokenId],
        })
        if (tips.length === 0) throw new Error('No spendable tips for this token')

        for (const tip of tips) {
          const kind = classifyBsv21TipKind({
            lockingScript: tip.lockingScript,
            cosignClaim: tip.cosign ?? null,
          })
          const path = chooseBsv21SendPath(kind)
          if (path.path !== 'plain') {
            return failSend(
              new Error(
                refuseReasonMessage(
                  path.path === 'refuse' ? path.reason : 'cosigner_required',
                ),
              ),
            )
          }
        }

        const need = BigInt(unitsStr)
        const { selected, selectedSum } = selectFungibleTips(tips, need)
        const changeAmt = selectedSum - need

        const chart = createActor(bsv21SendMachine).start()
        chart.send({
          type: 'START',
          tokenId: token.tokenId,
          sendPath: { path: 'plain' },
        })
        if (!chart.getSnapshot().matches('plainSend')) {
          chart.stop()
          return failSend(new Error('bsv21SendMachine did not enter plainSend'))
        }

        const transferBuilt = buildBsv21TransferLockingScript({
          address: to,
          tokenId: token.tokenId,
          amt: unitsStr,
          sym: token.sym,
          icon: token.icon,
          dec: token.dec,
        })

        const settlePath: ItemSettlePath = chooseItemSettlePath({
          paysOurAddress: scriptPaysAddress(
            transferBuilt.lockingScript,
            wallet.address,
          ),
          recipientIdentityKey: args.recipientIdentityKey,
        })

        const itemChart = createActor(itemSendMachine).start()
        itemChart.send({
          type: 'START',
          outpoint: wireOutpoint(selected[0]!.outpoint),
          settlePath,
        })
        itemChart.send({ type: 'BUILT' })

        const remittanceTags = stampBrc164Id([
          ...bsv21Tags({
            tokenId: token.tokenId,
            amt: unitsStr,
            sym: token.sym,
            issuer: token.issuer,
          }),
          'op:transfer',
        ])
        const remittanceCi = buildBsv21CustomInstructions({
          tokenId: token.tokenId,
          amt: unitsStr,
          op: 'transfer',
          sym: token.sym,
          icon: token.icon,
          dec: token.dec,
          issuer: token.issuer,
        })

        const outputs: Array<{
          lockingScript: string
          satoshis: number
          outputDescription: string
          basket: string
          tags: string[]
          customInstructions: string
        }> = [
          {
            lockingScript: transferBuilt.lockingScript,
            satoshis: 1,
            outputDescription: `${token.sym} transfer`,
            basket: BSV21_BASKET,
            tags: remittanceTags,
            customInstructions: remittanceCi,
          },
        ]

        if (changeAmt > 0n) {
          const changeBuilt = buildBsv21TransferLockingScript({
            address: wallet.address,
            tokenId: token.tokenId,
            amt: changeAmt.toString(),
            sym: token.sym,
            icon: token.icon,
            dec: token.dec,
          })
          outputs.push({
            lockingScript: changeBuilt.lockingScript,
            satoshis: 1,
            outputDescription: `${token.sym} change`,
            basket: BSV21_BASKET,
            tags: stampBrc164Id([
              ...bsv21Tags({
                tokenId: token.tokenId,
                amt: changeAmt.toString(),
                sym: token.sym,
                issuer: token.issuer,
              }),
              'op:transfer',
            ]),
            customInstructions: buildBsv21CustomInstructions({
              tokenId: token.tokenId,
              amt: changeAmt.toString(),
              op: 'transfer',
              sym: token.sym,
              icon: token.icon,
              dec: token.dec,
              issuer: token.issuer,
            }),
          })
        }

        const inputs = selected.map((tip) => ({
          outpoint: wireOutpoint(tip.outpoint),
          inputDescription: `${token.sym} tip`,
          unlockingScriptLength: 108,
        }))

        setPaymentProgress(
          'signing',
          `Signing ${token.sym} for the recipient`,
          token.outpoint,
        )
        console.info('[fungibles] createAction start')

        let result: Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>
        let attemptedBatchAbort = false
        for (;;) {
          try {
            result = await wallet.wallet.createAction({
              description: `Send ${token.sym}`.slice(0, 50),
              labels: [BSV21_BASKET, 'handcash-send-token'],
              inputs,
              outputs,
              options: {
                trustSelf: 'known',
                randomizeOutputs: false,
                signAndProcess: true,
                noSend: true,
              },
            })
            break
          } catch (err) {
            const { isReservedActionBatchError, abortReservedActionBatches } =
              await import('./actionReview')
            if (!attemptedBatchAbort && isReservedActionBatchError(err)) {
              attemptedBatchAbort = true
              await abortReservedActionBatches(wallet)
              continue
            }
            itemChart.send({
              type: 'FAIL',
              error: err instanceof Error ? err.message : String(err),
            })
            itemChart.stop()
            chart.stop()
            return failSend(err)
          }
        }

        rememberBeefTree(
          atomicBeefFromWalletResult(result) ??
            (result.signableTransaction?.tx
              ? Array.from(result.signableTransaction.tx)
              : undefined),
          typeof result.txid === 'string' ? result.txid : undefined,
        )
        itemChart.send({ type: 'CREATED', txid: result.txid })

        const txid = (result.txid ?? '').trim().toLowerCase()
        let atomicBeef = atomicBeefFromWalletResult(result)
        if (!txid) {
          itemChart.stop()
          chart.stop()
          return failSend(new Error('Send completed without txid'))
        }
        if (!atomicBeef?.length && result.signableTransaction?.tx) {
          // Prefer signed atomic from the createAction result; fall back to beef tree.
          try {
            const beef = Beef.fromBinary(result.signableTransaction.tx)
            atomicBeef = Array.from(beef.toBinaryAtomic(txid))
          } catch {
            /* keep undefined */
          }
        }
        if (!atomicBeef?.length) {
          itemChart.stop()
          chart.stop()
          return failSend(new Error('Send completed without signed BEEF'))
        }
        rememberBeefTree(atomicBeef, txid)
        try {
          await wallet.wallet.actionBatch.abort()
        } catch {
          /* unused funding reservations only */
        }

        const settleSnap = itemChart.getSnapshot()
        try {
          if (mustDeliverToPeer(settleSnap)) {
            if (settlePath.settle !== 'peerDeliver') {
              itemChart.stop()
              chart.stop()
              return failSend(
                new Error('itemSendMachine peerDeliver without settle path'),
              )
            }
            setPaymentProgress(
              'finishing',
              `Delivering ${token.sym} to recipient`,
              token.outpoint,
            )
            const { notifyPeerItemIncoming } = await import('./messageTransport')
            const friend = listFriends().find(
              (f) =>
                f.identityKey.toLowerCase() ===
                settlePath.recipientIdentityKey.toLowerCase(),
            )
            const delivered = await notifyPeerItemIncoming({
              recipientIdentityKey: settlePath.recipientIdentityKey,
              rootKeyHex: wallet.rootKeyHex,
              senderIdentityKey: wallet.identityKey,
              messagebox: friend?.messagebox,
              txid,
              itemName: token.sym,
              atomicBeef,
            })
            console.info(
              `[fungibles] peerDeliver box=${delivered.delivered} beefInBox=${delivered.beefInBox}`,
            )
            if (delivered.delivered === 'cloud') {
              itemChart.send({ type: 'DELIVERED' })
            } else {
              itemChart.send({ type: 'DELIVER_FAILED' })
            }
            if (!maySenderBroadcast(itemChart.getSnapshot())) {
              itemChart.stop()
              chart.stop()
              return failSend(
                new Error('itemSendMachine refused sender broadcast'),
              )
            }
            const silent = isSilentSenderBroadcast(itemChart.getSnapshot())
            if (!silent) {
              setPaymentProgress(
                'broadcasting',
                'Inbox unreachable — submitting on chain',
                token.outpoint,
              )
            }
            const ok = await broadcastAtomicBeef(txid, atomicBeef)
            if (silent) {
              itemChart.send({ type: ok ? 'BROADCASTED' : 'SKIPPED' })
            } else if (!ok) {
              itemChart.stop()
              chart.stop()
              return failSend(new Error('Not sent'))
            } else {
              itemChart.send({ type: 'BROADCASTED' })
            }
          } else if (maySenderBroadcast(settleSnap)) {
            setPaymentProgress(
              'broadcasting',
              settleSnap.matches('selfReceive')
                ? `Broadcasting ${token.sym} back to this wallet`
                : `Broadcasting ${token.sym}`,
              token.outpoint,
            )
            const ok = await broadcastAtomicBeef(txid, atomicBeef)
            if (!ok) {
              itemChart.stop()
              chart.stop()
              return failSend(new Error('Broadcast failed'))
            }
            itemChart.send({ type: 'BROADCASTED' })
          } else {
            itemChart.stop()
            chart.stop()
            return failSend(
              new Error('No legal broadcast edge for this settle path'),
            )
          }
        } catch (err) {
          itemChart.send({
            type: 'FAIL',
            error: err instanceof Error ? err.message : String(err),
          })
          itemChart.stop()
          chart.stop()
          return failSend(err)
        }

        completePendingSend(outboundPending.id, txid)
        noteOutboundSendComplete({
          pendingId: outboundPending.id,
          txid,
          sats: 1,
          to: args.toAddress,
          friendLabel: args.friendLabel ?? null,
          recipientIdentityKey: args.recipientIdentityKey ?? null,
          item: { ...activityItem, outpoint: `${txid}.0` },
        })
        clearPendingSend(outboundPending.id)

        await relinquishTips(
          wallet,
          selected.map((t) => t.outpoint),
        )
        scheduleHistoryBackupPush('sendFungible')
        void listFungibles(wallet).catch((err) => {
          console.warn('[fungibles] post-send refresh failed', err)
        })

        chart.send({ type: 'SUCCESS', txid })
        chart.stop()
        itemChart.stop()
        clearPaymentProgress()
        console.info(`[fungibles] send done txid=${txid}`)
        return { txid }
      } catch (err) {
        return failSend(err)
      }
    })
  } catch (err) {
    return failSend(err)
  }
}
