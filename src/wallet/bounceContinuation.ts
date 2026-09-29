/**
 * A transaction-bounce deposit is finished by the page that asked for it:
 * it posts the signed deposit to its server and then internalizes the refund.
 * On Android that page is usually system Chrome, which freezes the moment
 * HandCash comes to the front, so the refund never starts until the user tabs
 * back. The wallet already holds the signed deposit, so it finishes the
 * round trip itself and the page's later call is a cache hit.
 */
import { isMarketListingOrigin } from './marketListing'
import { alreadyInternalizedError } from './peerIngestHelpers'

const DERIVATION_PART = /^[A-Za-z0-9+/_=-]{1,128}$/
const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/i
const REFUND_TIMEOUT_MS = 20_000

export type BounceDeposit = {
  derivationPrefix: string
  derivationSuffix: string
}

/** The deposit output a bounce page asks createAction to sign, or null. */
export function bounceDepositFromCreateAction(request: unknown): BounceDeposit | null {
  const outputs = (request as { outputs?: unknown } | null)?.outputs
  if (!Array.isArray(outputs)) return null
  for (const output of outputs) {
    const raw = (output as { customInstructions?: unknown } | null)?.customInstructions
    if (typeof raw !== 'string' || !raw) continue
    let parsed: { derivationPrefix?: unknown; derivationSuffix?: unknown; payee?: unknown }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      continue
    }
    const derivationPrefix = typeof parsed.derivationPrefix === 'string' ? parsed.derivationPrefix : ''
    const derivationSuffix = typeof parsed.derivationSuffix === 'string' ? parsed.derivationSuffix : ''
    const payee = typeof parsed.payee === 'string' ? parsed.payee : ''
    if (
      DERIVATION_PART.test(derivationPrefix) &&
      DERIVATION_PART.test(derivationSuffix) &&
      IDENTITY_KEY.test(payee)
    ) {
      return { derivationPrefix, derivationSuffix }
    }
  }
  return null
}

export function bounceRefundUrl(originator: string | undefined): string | null {
  const host = originator?.trim()
  if (!host || !isMarketListingOrigin(host)) return null
  const bare = (host.split(':')[0] ?? host).toLowerCase()
  const proto = bare === 'localhost' || bare === '127.0.0.1' ? 'http' : 'https'
  return `${proto}://${host}/v1/tx-bounce/refund`
}

function atomicBeefBytes(result: unknown): number[] | null {
  const tx = (result as { tx?: unknown } | null)?.tx
  if (tx instanceof Uint8Array) return Array.from(tx)
  if (
    Array.isArray(tx) &&
    tx.length > 0 &&
    tx.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return tx as number[]
  }
  return null
}

/**
 * Broadcast the refund and credit it. Never throws: a failure leaves the
 * page's own retry, which runs when the browser tab thaws.
 */
export async function continueTxBounceRefund(args: {
  originator: string | undefined
  request: unknown
  result: unknown
  identityKey: string
  internalize: (body: unknown) => Promise<unknown>
  fetchImpl?: typeof fetch
}): Promise<void> {
  const deposit = bounceDepositFromCreateAction(args.request)
  const url = bounceRefundUrl(args.originator)
  const beef = atomicBeefBytes(args.result)
  const txid = String((args.result as { txid?: unknown } | null)?.txid ?? '').trim().toLowerCase()
  if (!deposit || !url || !beef || !/^[0-9a-f]{64}$/.test(txid)) return
  if (!IDENTITY_KEY.test(args.identityKey)) return
  const started = Date.now()
  try {
    const response = await (args.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txid,
        atomicBeef: beef,
        outputIndex: 0,
        senderIdentityKey: args.identityKey,
        derivationPrefix: deposit.derivationPrefix,
        derivationSuffix: deposit.derivationSuffix,
      }),
      signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
    })
    const refund = (await response.json().catch(() => null)) as {
      atomicBeef?: unknown
      outputIndex?: unknown
      remittance?: { derivationPrefix?: unknown; derivationSuffix?: unknown }
      senderIdentityKey?: unknown
      refundTxid?: unknown
      description?: unknown
      error?: unknown
    } | null
    if (!response.ok || !refund || !Array.isArray(refund.atomicBeef)) {
      console.warn(
        '[brc100] bounce refund refused',
        response.status,
        refund?.description || refund?.error || '',
      )
      return
    }
    try {
      await args.internalize({
        tx: refund.atomicBeef,
        description: 'Reference app BRC-29 refund',
        labels: ['brc29', 'tx-bounce', 'refund'],
        outputs: [
          {
            outputIndex: Number(refund.outputIndex ?? 0),
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: refund.remittance?.derivationPrefix,
              derivationSuffix: refund.remittance?.derivationSuffix,
              senderIdentityKey: refund.senderIdentityKey,
            },
          },
        ],
      })
    } catch (err) {
      if (!alreadyInternalizedError(err)) throw err
    }
    console.info(
      `[brc100] bounce-refund done ${Date.now() - started}ms — ${String(refund.refundTxid ?? '').slice(0, 12)}`,
    )
  } catch (err) {
    console.warn(
      '[brc100] bounce refund did not finish; the page retries when its tab resumes',
      err instanceof Error ? err.message : String(err),
    )
  }
}
