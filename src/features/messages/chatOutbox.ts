import type { Friend } from '../../wallet/friends'
import { getFriendById } from '../../wallet/friends'
import { appendMessage, updateMessage, type ChatMessage } from '../../wallet/messageStore'
import { deliverOutbound, encodeMessageBody, uploadChatFile } from '../../wallet/messageTransport'
import { playPaymentSuccessSound } from '../../wallet/paymentSuccessSound'
import { sendBrc29ToIdentityKey } from '../../wallet/sendBrc29Payment'
import { sendSatsToAddress } from '../../wallet/sendPayment'
import { getActiveWallet } from '../../wallet/session'
import { playWalletSound } from '../../wallet/soundService'
import { chatPaymentDescription } from './chatFormat'

type ChatRecipient = Pick<Friend, 'id' | 'identityKey' | 'messagebox'>

export function activeRootKeyHex(): string | undefined {
  return getActiveWallet()?.rootKeyHex
}

export function deliverToFriend(args: {
  friend: ChatRecipient
  identityKey: string
  rootKeyHex: string
  body: string
  peerId?: string
}): ReturnType<typeof deliverOutbound> {
  return deliverOutbound({
    recipientIdentityKey: args.friend.identityKey,
    senderIdentityKey: args.identityKey,
    rootKeyHex: args.rootKeyHex,
    body: args.body,
    peerId: args.peerId ?? args.friend.id,
    messagebox: args.friend.messagebox,
  })
}

/** Fire-and-forget delivery; stays local when there is no identity or the wallet is locked. */
export function deliverIfUnlocked(
  friend: ChatRecipient,
  identityKey: string | undefined,
  body: string,
  peerId?: string,
): void {
  const rootKeyHex = activeRootKeyHex()
  if (!identityKey || !rootKeyHex) return
  void deliverToFriend({ friend, identityKey, rootKeyHex, body, peerId })
}

export type ChatPaymentSent = {
  txid: string
  balanceSats: number
  brc29?: { derivationPrefix: string; derivationSuffix: string; outputIndex: number }
}

/** Pays a chat card on-chain: BRC-29 to the payee's identity key, else P2PKH to its address. */
export async function sendChatPayment(args: {
  payeeKey: string | null
  to?: string
  sats: number
  friendLabel?: string
  memo?: string
}): Promise<ChatPaymentSent> {
  const description = chatPaymentDescription(args.memo, args.payeeKey, args.to)
  if (args.payeeKey) {
    const sent = await sendBrc29ToIdentityKey({
      payeeIdentityKey: args.payeeKey,
      satoshis: args.sats,
      friendLabel: args.friendLabel,
      description,
      chatRef: true,
    })
    return {
      txid: sent.txid,
      balanceSats: sent.balanceSats,
      brc29: {
        derivationPrefix: sent.remittance.derivationPrefix,
        derivationSuffix: sent.remittance.derivationSuffix,
        outputIndex: sent.remittance.outputIndex ?? 0,
      },
    }
  }
  const sent = await sendSatsToAddress({
    to: args.to!,
    satoshis: args.sats,
    friendLabel: args.friendLabel,
    description,
  })
  return { txid: sent.txid, balanceSats: sent.balanceSats }
}

/**
 * Sends a pending pay or tip card and records the outcome on it. Never throws:
 * failures land on the card as `failed`.
 */
export async function confirmChatPayment(
  msg: ChatMessage,
  ctx: {
    identityKey?: string
    onHint: (hint: string) => void
    onSent?: (balanceSats: number) => void
  },
): Promise<void> {
  const payeeKey = msg.meta?.payeeIdentityKey?.trim() || null
  const to = msg.meta?.to
  const sats = msg.meta?.sats
  if ((!payeeKey && !to) || !sats || sats <= 0) {
    updateMessage(msg.id, {
      meta: { payStatus: 'failed', status: 'Failed', error: 'Missing payment details' },
    })
    playWalletSound('error')
    return
  }

  updateMessage(msg.id, {
    meta: { payStatus: 'sending', status: 'Sending…', error: undefined },
  })

  try {
    const { txid, balanceSats, brc29 } = await sendChatPayment({
      payeeKey,
      to,
      sats,
      friendLabel: msg.meta?.friendLabel,
      memo: msg.meta?.memo,
    })
    const sent = updateMessage(msg.id, {
      meta: { payStatus: 'sent', status: 'Sent', txid, brc29, error: undefined },
    })
    const recipient = getFriendById(msg.peerId)
    const identityKey = ctx.identityKey
    const selfPay =
      !!recipient && !!identityKey && recipient.identityKey.toLowerCase() === identityKey.toLowerCase()
    // BRC-29 already delivered the signed payment to the peer.
    if (sent && recipient && identityKey && !selfPay && !payeeKey) {
      const rootKeyHex = activeRootKeyHex()
      if (!rootKeyHex) {
        ctx.onHint('Payment sent on-chain, but chat delivery needs an unlocked wallet.')
      } else {
        const delivered = await deliverToFriend({
          friend: recipient,
          identityKey,
          rootKeyHex,
          body: encodeMessageBody(sent),
          peerId: msg.peerId,
        })
        if (delivered.delivered !== 'cloud') {
          ctx.onHint('Payment sent on-chain, but the chat card could not be delivered yet.')
        }
      }
    }
    playPaymentSuccessSound()
    ctx.onSent?.(balanceSats)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    updateMessage(msg.id, { meta: { payStatus: 'failed', status: 'Failed', error } })
    playWalletSound('error')
  }
}

/** Uploads a file for the friend, delivers its card, then appends it to the thread. Throws on any failure. */
export async function sendChatFile(file: File, friend: ChatRecipient, identityKey: string): Promise<void> {
  const rootKeyHex = activeRootKeyHex()
  if (!rootKeyHex) throw new Error('Wallet locked')
  const attachment = await uploadChatFile({
    file,
    recipientIdentityKey: friend.identityKey,
    senderIdentityKey: identityKey,
    rootKeyHex,
    messagebox: friend.messagebox,
  })
  const outbound = {
    kind: 'file',
    text: attachment.name,
    meta: { attachment, status: 'Sent file' },
  } as const
  const delivered = await deliverToFriend({
    friend,
    identityKey,
    rootKeyHex,
    body: encodeMessageBody(outbound),
  })
  if (delivered.delivered !== 'cloud') {
    throw new Error('File uploaded, but the message could not be delivered')
  }
  appendMessage(friend.id, { direction: 'out', ...outbound })
}
