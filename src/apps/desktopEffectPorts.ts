import type { Chain } from '../wallet/vault'
import { getActiveWallet } from '../wallet/session'
import { getFriendById, getFriendByIdentityKey, type Friend } from '../wallet/friends'
import { appendMessage } from '../wallet/messageStore'
import {
  clearOwnBoxMessages,
  deliverOutbound,
  encodeMessageBody,
  reviewOwnBox,
} from '../wallet/messageTransport'
import { hasSettledActivityTxid, recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../wallet/appActivity'
import { signIdentityText } from '../wallet/messageboxAuth'
import { blockSender, listBlockedSenders, unblockSender } from '../wallet/blockedSenders'
import type {
  BoxMessage,
  ChartEffectPorts,
  ChartNetwork,
  ChartWalletSupport,
  EffectResult,
  ResolvedEffect,
} from './chartTypes'
import { formatChartAmount } from './chartEffects'
import { shortIdentityKey } from './chartFormat'

/** Boxes charts may reach. The others carry device, swap and settlement traffic the wallet handles itself. */
export const DESKTOP_CHART_BOXES = ['inbox'] as const

export function chartNetworkFor(chain: Chain): ChartNetwork {
  return chain === 'test' ? 'testnet' : 'mainnet'
}

/** HandCash runs Bitcoin SV on the network of the open wallet. */
export function desktopChartSupport(chain: Chain): ChartWalletSupport {
  return { coins: [{ coin: 'BSV', network: chartNetworkFor(chain) }], boxes: DESKTOP_CHART_BOXES }
}

/** The text an app gets signed: domain-separated so it can never pass as a wallet or box challenge. */
export function chartSignedText(appId: string, message: string): string {
  return `Chart app signature\n${appId}\n${message}`
}

export const CHART_FETCH_MAX_CHARS = 4000

function friendName(identityKey: string): string {
  const friend = getFriendByIdentityKey(identityKey)
  return friend?.handle || friend?.label || shortIdentityKey(identityKey)
}

function byBox(messages: readonly BoxMessage[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const m of messages) groups.set(m.box, [...(groups.get(m.box) ?? []), m.id])
  return groups
}

function requireWallet() {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  return active
}

function requireNetwork(network: ChartNetwork): void {
  const active = requireWallet()
  if (chartNetworkFor(active.chain) !== network) throw new Error(`This wallet is not on ${network}`)
}

/**
 * Desktop's side of every chart effect, each on the wallet call the rest of
 * the app uses, so sends and requests land on their own Activity rows.
 */
export const desktopEffectPorts: ChartEffectPorts = {
  async run(effect: ResolvedEffect, app): Promise<EffectResult> {
    switch (effect.kind) {
      case 'sendPayment': {
        if (effect.coin !== 'BSV') throw new Error('This wallet sends Bitcoin SV only')
        requireNetwork(effect.network)
        const { sendBrc29ToIdentityKey } = await import('../wallet/sendBrc29Payment')
        await sendBrc29ToIdentityKey({
          payeeIdentityKey: effect.to.identityKey,
          satoshis: effect.amount,
          friendLabel: effect.to.label,
          description: effect.memo ? `${app.name}: ${effect.memo}` : app.name,
        })
        return { kind: 'none' }
      }
      case 'sendItem': {
        if (effect.coin !== 'BSV') throw new Error('This wallet sends Bitcoin SV items only')
        requireNetwork(effect.network)
        const { sendCollectable } = await import('../wallet/collectables')
        await sendCollectable({
          outpoint: effect.item.outpoint,
          toAddress: effect.to.identityKey,
          recipientIdentityKey: effect.to.identityKey,
          friendLabel: effect.to.label,
          name: effect.item.name,
        })
        return { kind: 'none' }
      }
      case 'requestPayment': {
        if (effect.coin !== 'BSV') throw new Error('This wallet requests Bitcoin SV only')
        requireNetwork(effect.network)
        const active = requireWallet()
        const amountLabel = formatChartAmount(effect.coin, effect.amountEach)
        const failures: string[] = []
        for (const r of effect.from) {
          const friend: Friend | null = getFriendById(r.id) ?? getFriendByIdentityKey(r.identityKey)
          const note = `Requested from ${r.label} in ${app.name}${effect.memo ? `: ${effect.memo}` : ''}`
          try {
            if (!friend) throw new Error(`${r.label} is not in your friends`)
            const request = appendMessage(friend.id, {
              direction: 'out',
              kind: 'pay-request',
              text: effect.memo || amountLabel,
              meta: { amountLabel, sats: effect.amountEach, status: 'Request' },
            })
            await deliverOutbound({
              recipientIdentityKey: friend.identityKey,
              senderIdentityKey: active.identityKey,
              rootKeyHex: active.rootKeyHex,
              senderHandle: active.handle || undefined,
              body: encodeMessageBody(request),
              peerId: friend.id,
              messagebox: friend.messagebox,
            })
            recordAppActivity({
              origin: WALLET_ACTIVITY_ORIGIN,
              kind: 'event',
              sats: effect.amountEach,
              method: 'Payment request',
              note,
              status: 'complete',
            })
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failures.push(`${r.label}: ${reason}`)
            recordAppActivity({
              origin: WALLET_ACTIVITY_ORIGIN,
              kind: 'event',
              sats: effect.amountEach,
              method: 'Payment request',
              note,
              status: 'failed',
              failureReason: reason,
            })
          }
        }
        if (failures.length) throw new Error(`Not sent to ${failures.join('; ')}`)
        return { kind: 'none' }
      }
      case 'signMessage': {
        const active = requireWallet()
        const signed = signIdentityText(active.rootKeyHex, chartSignedText(effect.appId, effect.message))
        return { kind: 'signature', value: { ...signed, message: effect.message } }
      }
      case 'fetch': {
        const res = await fetch(effect.url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
        const text = (await res.text()).slice(0, CHART_FETCH_MAX_CHARS)
        return { kind: 'fetched', value: { url: effect.url, status: res.status, text } }
      }
      case 'listMessages': {
        const active = requireWallet()
        const messages: BoxMessage[] = []
        for (const box of effect.boxes) {
          if (!(DESKTOP_CHART_BOXES as readonly string[]).includes(box)) throw new Error(`Apps cannot read the ${box} box`)
          for (const m of await reviewOwnBox(active.rootKeyHex, box)) {
            if (!m.messageId) continue
            messages.push({
              id: m.messageId,
              box,
              sender: m.sender,
              senderName: m.sender ? friendName(m.sender) : 'Unknown sender',
              at: m.createdAt,
              kind: m.kind,
              text: m.text,
            })
          }
        }
        messages.sort((a, b) => b.at - a.at)
        const blocked = listBlockedSenders().map((b) => ({ identityKey: b.identityKey, name: b.name }))
        return { kind: 'messages', messages, blocked }
      }
      case 'acknowledgeMessages': {
        const active = requireWallet()
        const listed = await Promise.all(
          [...byBox(effect.messages).keys()].map((box) => reviewOwnBox(active.rootKeyHex, box)),
        )
        const txidOf = new Map(listed.flat().map((m) => [m.messageId, m.txid]))
        const unsettled = effect.messages.filter((m) => {
          if (m.kind !== 'payment-notice' && m.kind !== 'tip') return false
          return !hasSettledActivityTxid(txidOf.get(m.id))
        })
        if (unsettled.length) {
          throw new Error(
            `${unsettled.length === 1 ? 'A payment notice is' : `${unsettled.length} payment notices are`} still waiting for this wallet to take the payment. Clear it on purpose if you want it gone.`,
          )
        }
        for (const [box, ids] of byBox(effect.messages)) await clearOwnBoxMessages(active.rootKeyHex, box, ids)
        return { kind: 'none' }
      }
      case 'deleteMessages': {
        const active = requireWallet()
        for (const [box, ids] of byBox(effect.messages)) {
          if (!(DESKTOP_CHART_BOXES as readonly string[]).includes(box)) throw new Error(`Apps cannot clear the ${box} box`)
          await clearOwnBoxMessages(active.rootKeyHex, box, ids)
        }
        return { kind: 'none' }
      }
      case 'blockSender':
        blockSender(effect.sender.identityKey, effect.sender.name)
        return { kind: 'none' }
      case 'unblockSender':
        unblockSender(effect.sender.identityKey)
        return { kind: 'none' }
    }
  },
}
