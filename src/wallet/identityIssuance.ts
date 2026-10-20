import { Beef } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { selfP2pkhOutput } from './brc29Keys'
import { rememberTipKey, selfTokenOutput } from './tipKeys'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { isItemIssuanceArgs } from './itemAccess'
import { issuanceSigner } from './publicIdentities'
import { appendIssuerMetadata } from './issuerMetadata'
import { parseOrdEnvelope } from './ordinalOwnership'
import { rememberBeefBinary } from './beefCache'
import { sigmaSignLockingScript } from './sigmaIssuer'
import { completeSignableWithTipKeys } from './signableCompletion'
import { framedInputBeef } from './verifiableInputBeef'
import { ITEM_STORAGE_BASKET } from './assetBaskets'

type Args = {
  description?: string
  labels?: string[]
  inputs?: Array<{ outpoint: string; inputDescription?: string; unlockingScriptLength?: number }>
  inputBEEF?: number[]
  outputs?: Array<{
    lockingScript?: string
    satoshis?: number
    outputDescription?: string
    basket?: string
    tags?: string[]
    customInstructions?: string
  }>
  options?: Record<string, unknown>
}

/**
 * Whether a new item carries a BRC-247 issuer stamp by the selected identity
 * key. Unsigned is a valid item: its content does not depend on a maker, and
 * the user may always choose it.
 */
export type IssuanceAttestation =
  | { kind: 'signed'; identityKey: string; displayName?: string }
  | { kind: 'unsigned'; reason: 'opted-out' }

export function isIdentityIssuanceArgs(method: string, args: unknown): boolean {
  return isItemIssuanceArgs(method, args)
}

/**
 * Standard 1Sat SDK anchor pattern: noSend anchor → vin-bound Sigma → sendWith.
 * The anchored action is `noSend` too: the Toolbox funds an action from a prior
 * action's `noSendChange` only when that action is itself `noSend`, and a
 * wallet whose one UTXO paid for the anchor holds nothing else. Once signed,
 * `sendWithAnchor` queues both together; until then aborting releases both.
 */
export async function withSigmaAnchor(
  active: ActiveWallet,
  args: Args,
): Promise<Args> {
  if (args.inputs?.length) return args
  // A BRC-29 self child, remembered so the mint's anchor input finds its key.
  const child = selfTokenOutput(active)
  rememberTipKey(active, child.key)
  const anchorRow = selfP2pkhOutput(active, [], child)
  const lock = anchorRow.lockingScript
  const anchor = await active.wallet.createAction({
    description: 'Sigma issuer anchor',
    outputs: [
      {
        ...anchorRow,
        satoshis: 2,
        outputDescription: 'Issuer signing anchor',
        basket: 'sigma',
      },
    ],
    options: {
      noSend: true,
      randomizeOutputs: false,
      acceptDelayedBroadcast: true,
    },
  })
  if (!anchor.txid || !anchor.tx?.length)
    throw new Error('Could not prepare the issuer signing anchor.')
  const source = Beef.fromBinary(anchor.tx).findTxid(anchor.txid)?.tx
  if (
    !source ||
    source.outputs[0]?.lockingScript.toHex() !== lock ||
    source.outputs[0]?.satoshis !== 2
  )
    throw new Error(
      'Issuer anchor output did not match the requested funding lock.',
    )
  rememberBeefBinary(anchor.txid, Array.from(anchor.tx))
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  return {
    ...args,
    inputs: [
      {
        outpoint: `${anchor.txid}.0`,
        inputDescription: 'Sigma issuer anchor',
        unlockingScriptLength: 108,
      },
    ],
    // A package whose change ancestry lacks a proof would refuse the whole
    // mint; that ancestry is storage-held, so it rides as txid-only.
    inputBEEF: framedInputBeef(Array.from(anchor.tx), 'identity-issuance', [anchor.txid]),
    options: {
      ...args.options,
      randomizeOutputs: false,
      noSend: true,
      noSendChange: [...strings(args.options?.noSendChange), ...(anchor.noSendChange ?? [])],
      knownTxids: [...strings(args.options?.knownTxids), anchor.txid],
      sendWith: undefined,
      trustSelf: 'known',
      acceptDelayedBroadcast: true,
    },
  }
}

/** Queue a signed `noSend` anchor and the transaction that spends it for broadcast, together. */
export async function sendWithAnchor(active: ActiveWallet, anchorTxid: string, txid: string): Promise<void> {
  const sent = await active.wallet.createAction({
    description: 'Send issuer anchor',
    options: { sendWith: [anchorTxid, txid], acceptDelayedBroadcast: true },
  })
  const { formatReviewActionsError, sendWithHasFailure } = await import('./actionReview')
  if (sendWithHasFailure(sent.sendWithResults))
    throw new Error(formatReviewActionsError({ sendWithResults: sent.sendWithResults, reviewActionResults: [] }))
}

export async function enrichIdentityIssuance(
  runtime: WalletRuntime,
  args: Args,
  expectedIssuer?: string,
): Promise<Args> {
  if (!runtimeIsCurrent(runtime))
    throw new Error('Wallet changed; approve again.')
  const active = runtime.instance
  if (!isNftIssuance(args)) return args
  const signer = issuanceSigner(runtime, expectedIssuer)
  // Validate new inscriptions before making a durable anchor transaction.
  assertValidInscriptions(args)
  const funded = await withSigmaAnchor(active, args)
  try {
    const signed = await signIssuance(runtime, funded, signer)
    if (funded !== args) anchors.set(signed, funded.inputs![0]!.outpoint)
    return signed
  } catch (err) {
    if (funded !== args) await abortQuietly(active, funded.inputs![0]!.outpoint.split('.')[0]!)
    throw err
  }
}

/** Issue without a stamp: no anchor, no issuer tape, no issuer tags. */
export async function prepareUnsignedIssuance(
  runtime: WalletRuntime,
  args: Args,
): Promise<Args> {
  if (!runtimeIsCurrent(runtime))
    throw new Error('Wallet changed; approve again.')
  if (isNftIssuance(args)) assertValidInscriptions(args)
  return { ...args, outputs: args.outputs?.map(withoutIssuerClaim) }
}

/** BRC-247: an unstamped output names no issuer in its tags or remittance. */
function withoutIssuerClaim(out: NonNullable<Args['outputs']>[number]): NonNullable<Args['outputs']>[number] {
  const next = { ...out }
  if (out.tags) next.tags = out.tags.filter(tag => !tag.trim().toLowerCase().startsWith('issuer:'))
  if (out.customInstructions) {
    try {
      const body = JSON.parse(out.customInstructions) as unknown
      if (body && typeof body === 'object' && !Array.isArray(body) && ('issuer' in body || 'bapId' in body)) {
        const { issuer: _issuer, bapId: _bapId, ...rest } = body as Record<string, unknown>
        next.customInstructions = JSON.stringify(rest)
      }
    } catch {
      // Not JSON, so it carries no issuer field.
    }
  }
  return next
}

function isOrdinal(out: NonNullable<Args['outputs']>[number]): boolean {
  return out.satoshis === 1 && out.basket?.trim().toLowerCase() === ITEM_STORAGE_BASKET
}

function isNftIssuance(args: Args): boolean {
  return isItemIssuanceArgs('createAction', args) && !!args.outputs?.some(isOrdinal)
}

function assertValidInscriptions(args: Args): void {
  if ((args.outputs ?? []).filter(isOrdinal).some((out) => !out.lockingScript || !parseOrdEnvelope(out.lockingScript)))
    throw new Error('A new collectable must contain a valid ord inscription.')
}

type IdentitySigner = ReturnType<typeof issuanceSigner>

const anchors = new WeakMap<object, string>()

export async function abortQuietly(active: ActiveWallet, reference: string): Promise<void> {
  try {
    await active.wallet.abortAction({ reference })
  } catch (err) {
    console.warn(`[identity-issuance] could not release ${reference.slice(0, 12)}`, err)
  }
}

/**
 * A mint that failed before broadcast leaves its `noSend` anchor holding
 * wallet change. Release the signable mint, then the anchor; the toolbox
 * refuses to abort anything that already reached the network.
 */
export async function releaseIdentityIssuance(
  runtime: WalletRuntime,
  enriched: unknown,
  result?: unknown,
): Promise<void> {
  const anchor = enriched && typeof enriched === 'object' ? anchors.get(enriched) : undefined
  if (!anchor) return
  anchors.delete(enriched as object)
  const active = runtime.instance
  const signable = (result as { signableTransaction?: { reference?: unknown } } | undefined)
    ?.signableTransaction?.reference
  if (typeof signable === 'string' && signable) await abortQuietly(active, signable)
  await abortQuietly(active, anchor.split('.')[0]!)
}

async function signIssuance(
  runtime: WalletRuntime,
  args: Args,
  signer: IdentitySigner,
): Promise<Args> {
  // Selection/account can change while anchor creation waits. Never sign with
  // a different key from the one the user saw in the approval.
  if (issuanceSigner(runtime, signer.identityKey).identityKey !== signer.identityKey)
    throw new Error('Issuer identity changed after approval; approve again.')
  const funded = args
  const match = funded.inputs![0]!.outpoint.match(/^([0-9a-f]{64})[._](\d+)$/i)
  if (!match)
    throw new Error('Issuer signature requires a valid funding outpoint.')
  return {
    ...funded,
    outputs: funded.outputs?.map((out) => {
      if (!isOrdinal(out)) return out
      let ci: Record<string, unknown> = {}
      if (out.customInstructions) {
        ci = JSON.parse(out.customInstructions)
        if (!ci || typeof ci !== 'object' || Array.isArray(ci))
          throw new Error('Invalid item remittance.')
      }
      // Keep remittance compact (BRC-37 / reference client's 1,000-byte limit).
      const { bapId: _bapId, ...rest } = ci
      const customInstructions = JSON.stringify({ ...rest, issuer: signer.identityKey })
      if (new TextEncoder().encode(customInstructions).length > 1000)
        throw new Error('Item remittance exceeds the BRC-100 size limit.')
      return {
        ...out,
        customInstructions,
        tags: [
          ...(out.tags ?? []).filter(
            (tag) => !tag.trim().toLowerCase().startsWith('issuer:'),
          ),
          `issuer:${signer.identityKey}`,
        ],
        lockingScript: sigmaSignLockingScript({
          lockingScriptHex: appendIssuerMetadata(out.lockingScript!, signer.identityKey),
          fundTxid: match[1]!,
          fundVout: Number(match[2]),
          identityKeyHex: signer.rootKeyHex,
        }),
      }
    }),
    options: { ...funded.options, randomizeOutputs: false },
  }
}

export async function finishIdentityIssuance(
  runtime: WalletRuntime,
  args: Args,
  result: unknown,
): Promise<unknown> {
  if (!runtimeIsCurrent(runtime))
    throw new Error('Wallet changed; approve again.')
  const active = runtime.instance
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return result
  const row = result as {
    txid?: string
    signableTransaction?: { tx: number[]; reference: string }
  }
  if (row.txid || !row.signableTransaction || !args.inputs?.length)
    return result
  const completed = await completeSignableWithTipKeys(
    active,
    row.signableTransaction,
    args.inputs.map((input) => input.outpoint),
  )
  const anchor = anchors.get(args)
  if (anchor) {
    await sendWithAnchor(active, anchor.split('.')[0]!, completed.txid)
    anchors.delete(args)
  }
  const { signableTransaction: _drop, ...rest } = row
  const { noSendChange: _sent, ...done } = completed as typeof completed & { noSendChange?: unknown }
  return { ...rest, ...done }
}
