import { P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction } from '@bsv/sdk'
import { DirectPayClient, PAYMENT_PROTOCOL_ID, type IncomingPayment, type WalletLike } from '@bsv/webrtpay'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeRtc } from './fakeRtc.fixture'
import { createBoxSignaler, receiveDirectPayments, type SignalBoxIo } from './payments'

const FAST = { receiveMs: 20, dialMs: 10 }
const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

/** One messagebox host: a `webrtpay_signals` box per identity. */
function host() {
  const boxes = new Map<string, Array<{ messageId: string; body: string; sender: string }>>()
  let n = 0
  const boxOf = (key: string) => boxes.get(key) ?? boxes.set(key, []).get(key)!
  return (me: string): SignalBoxIo => ({
    list: async () => boxOf(me).map((m) => ({ ...m })),
    acknowledge: async (ids) => {
      boxes.set(me, boxOf(me).filter((m) => !ids.includes(m.messageId)))
    },
    send: async (to, body) => void boxOf(to).push({ messageId: `m${++n}`, body, sender: me }),
  })
}

function walletOf(root: PrivateKey): WalletLike {
  const proto = new ProtoWallet(root)
  return Object.assign(proto, { internalizeAction: async () => ({ accepted: true as const }) }) as unknown as WalletLike
}

async function tokenFor(payer: PrivateKey, payee: string, amount: number) {
  const derivationPrefix = Buffer.from('prefix-01').toString('base64')
  const derivationSuffix = Buffer.from('suffix-01').toString('base64')
  const { publicKey } = await new ProtoWallet(payer).getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payee,
  })
  const parent = new Transaction()
  parent.addOutput({ lockingScript: new P2PKH().lock(payer.toAddress()), satoshis: amount + 100 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(payer.toAddress()) })
  tx.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()), satoshis: amount })
  return {
    txid: tx.id('hex'),
    token: { customInstructions: { derivationPrefix, derivationSuffix }, transaction: tx.toAtomicBEEF(), amount, outputIndex: 0 },
  }
}

describe('direct payments in (webrtpay/1, purpose payment)', () => {
  it('takes a payment from a webrtpay payer and acks what the wallet decided', async () => {
    const box = host()
    const payee = PrivateKey.fromRandom()
    const payer = PrivateKey.fromRandom()
    const payeeKey = payee.toPublicKey().toString()
    const payerKey = payer.toPublicKey().toString()
    const taken: Array<{ payment: IncomingPayment; txid: string }> = []
    stops.push(
      await receiveDirectPayments({
        rootKeyHex: payee.toHex(),
        chain: 'main',
        io: box(payeeKey),
        rtc: fakeRtc(),
        cadence: FAST,
        take: async (payment, txid) => {
          taken.push({ payment, txid })
          return 'accepted'
        },
      }),
    )
    const signaler = createBoxSignaler(box(payerKey), 'payer', FAST)
    const client = new DirectPayClient({ wallet: walletOf(payer), signaler, chain: 'main', rtc: { RTCPeerConnection: fakeRtc() } })
    stops.push(async () => {
      await client.close()
      signaler.stop()
    })
    const { txid, token } = await tokenFor(payer, payeeKey, 1_000)
    const peer = await client.connect(payeeKey)
    expect(peer.peerIdentityKey).toBe(payeeKey)
    const ack = await client.sendPayment(peer, token)
    expect(ack).toMatchObject({ status: 'accepted', txid })
    expect(taken).toHaveLength(1)
    expect(taken[0]!.txid).toBe(txid)
    expect(taken[0]!.payment.sender).toBe(payerKey)
    expect(taken[0]!.payment.token.amount).toBe(1_000)
  })

  it('refuses a payer on another network before any connection', async () => {
    const box = host()
    const payee = PrivateKey.fromRandom()
    const payer = PrivateKey.fromRandom()
    const payeeKey = payee.toPublicKey().toString()
    stops.push(
      await receiveDirectPayments({ rootKeyHex: payee.toHex(), chain: 'main', io: box(payeeKey), rtc: fakeRtc(), cadence: FAST, take: async () => 'accepted' }),
    )
    const signaler = createBoxSignaler(box(payer.toPublicKey().toString()), 'payer', FAST)
    const client = new DirectPayClient({ wallet: walletOf(payer), signaler, chain: 'test', rtc: { RTCPeerConnection: fakeRtc() } })
    stops.push(async () => {
      await client.close()
      signaler.stop()
    })
    await expect(client.connect(payeeKey)).rejects.toMatchObject({ code: 'rejected', reason: 'wrong_network' })
  })
})
