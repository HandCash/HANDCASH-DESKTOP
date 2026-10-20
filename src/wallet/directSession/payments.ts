/**
 * Direct payments received over `webrtpay/1` (purpose `payment`, box
 * `webrtpay_signals`), so a payer such as BSV Desktop can pay this wallet
 * peer to peer. `@bsv/webrtpay`'s client runs the protocol; custody goes
 * through the wallet's own internalize, as a messagebox payment does.
 */

import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  DirectPayClient,
  isSignalEnvelope,
  type IncomingPayment,
  type PaymentDecision,
  type Signaler,
  type WalletLike,
} from '@bsv/webrtpay'
import { createBoxPoller, type PollIo } from './boxPoller'
import type { RtcConstructor } from './session'

export type SignalBoxIo = PollIo & { send: (to: string, body: string) => Promise<void> }
export type TakePayment = (payment: IncomingPayment, txid: string) => Promise<PaymentDecision>

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

/** A `webrtpay/1` carrier on a polled box: envelope JSON as the message body (§7.7). */
export function createBoxSignaler(
  io: SignalBoxIo,
  tag: string,
  cadence: { receiveMs?: number; dialMs?: number } = {},
): Signaler & { stop: () => void } {
  const subs = new Set<{ fn: Parameters<Signaler['listen']>[0] }>()
  let active = false
  const poller = createBoxPoller({
    ...cadence,
    tag,
    io,
    dialing: () => active,
    handle: async (m) => {
      let envelope: unknown
      try {
        envelope = JSON.parse(m.body)
      } catch {
        return 'ack'
      }
      if (!isSignalEnvelope(envelope)) return 'ack'
      for (const sub of [...subs]) {
        try {
          sub.fn(m.sender, { v: envelope.v, sid: envelope.sid, ciphertext: envelope.ciphertext })
        } catch {
          // a faulty handler must not stop signalling
        }
      }
      return 'ack'
    },
  })
  return {
    async send(to, envelope) {
      await io.send(to, JSON.stringify(envelope))
    },
    async listen(fn) {
      const sub = { fn }
      subs.add(sub)
      poller.start()
      return async () => {
        subs.delete(sub)
        if (subs.size === 0) poller.stop()
      }
    },
    setActive(next) {
      active = next
      if (next) poller.nudge()
    },
    stop() {
      subs.clear()
      poller.stop()
    },
  }
}

/**
 * The wallet slice `DirectPayClient` needs, from the account root (BRC-100
 * derivations only). Payments are taken by `take`, never internalized here.
 */
function channelWallet(rootKeyHex: string): WalletLike {
  const proto = new ProtoWallet(PrivateKey.fromHex(rootKeyHex.trim()))
  return {
    getPublicKey: (args) => proto.getPublicKey(args),
    createSignature: (args) => proto.createSignature(args),
    verifySignature: (args) => proto.verifySignature(args),
    encrypt: (args) => proto.encrypt(args),
    decrypt: (args) => proto.decrypt(args),
    createHmac: (args) => proto.createHmac(args),
    verifyHmac: (args) => proto.verifyHmac(args),
    internalizeAction: () => Promise.reject(new Error('Direct payments are taken by the wallet')),
  }
}

/** Receive direct payments until the returned stop runs. */
export async function receiveDirectPayments(args: {
  rootKeyHex: string
  chain: string
  io: SignalBoxIo
  take: TakePayment
  rtc?: RtcConstructor
  cadence?: { receiveMs?: number; dialMs?: number }
}): Promise<() => Promise<void>> {
  const signaler = createBoxSignaler(args.io, 'direct-pay', args.cadence)
  const client = new DirectPayClient({
    wallet: channelWallet(args.rootKeyHex),
    signaler,
    chain: args.chain,
    rtc: { iceServers: ICE_SERVERS, ...(args.rtc ? { RTCPeerConnection: args.rtc } : {}) },
  })
  await client.startReceiving({
    onPayment: (payment, ctx) => args.take(payment, ctx.txid),
    onError: (err) => console.info(`[direct-pay] ${err instanceof Error ? err.message : String(err)}`),
  })
  return async () => {
    await client.close()
    signaler.stop()
  }
}
