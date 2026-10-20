/**
 * Direct payments in (`webrtpay/1`, box `webrtpay_signals` on this account's
 * box), for as long as the account is unlocked. A payment is credited by
 * `internalizeBrc29Payment`, exactly as a messagebox payment card is; one it
 * does not accept is acked `rejected`, so the payer keeps the token and
 * delivers it again.
 */
import { SIGNALS_MESSAGEBOX, type PaymentDecision } from '@bsv/webrtpay'
import { receiveDirectPayments } from './directSession/payments'

let generation = 0
let stop: (() => Promise<void>) | null = null

export async function startDirectPayments(account: { rootKeyHex: string; chain: string }): Promise<void> {
  const mine = ++generation
  await stopReceiver()
  if (typeof globalThis.RTCPeerConnection !== 'function') return
  const transport = await import('./messageTransport')
  const { internalizeBrc29Payment } = await import('./sendBrc29Payment')
  const { rootKeyHex } = account
  try {
    const stopNext = await receiveDirectPayments({
      rootKeyHex,
      chain: account.chain,
      io: {
        list: async () =>
          (await transport.listOwnBox(rootKeyHex, SIGNALS_MESSAGEBOX))?.map((m) => ({
            messageId: String(m.messageId ?? ''),
            body: m.body,
            sender: transport.listedSender(m),
          })) ?? null,
        acknowledge: (ids) => transport.acknowledgeOwnBox(rootKeyHex, SIGNALS_MESSAGEBOX, ids),
        send: (to, body) => transport.postToPeerBox(rootKeyHex, to, SIGNALS_MESSAGEBOX, body),
      },
      take: async (payment, txid): Promise<PaymentDecision> => {
        const result = await internalizeBrc29Payment({
          txid,
          remittance: {
            derivationPrefix: payment.token.customInstructions.derivationPrefix,
            derivationSuffix: payment.token.customInstructions.derivationSuffix,
            outputIndex: payment.token.outputIndex ?? 0,
          },
          senderIdentityKey: payment.sender,
          tx: payment.token.transaction,
          satoshis: payment.token.amount,
        })
        return result.accepted ? 'accepted' : { status: 'rejected', reason: result.reason ?? 'not accepted' }
      },
    })
    if (mine !== generation) await stopNext()
    else stop = stopNext
  } catch (err) {
    console.info(`[direct-pay] receiver did not start — ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function stopDirectPayments(): void {
  generation += 1
  void stopReceiver()
}

async function stopReceiver(): Promise<void> {
  const current = stop
  stop = null
  await current?.().catch(() => undefined)
}
