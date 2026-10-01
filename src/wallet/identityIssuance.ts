import { Beef, P2PKH, PublicKey } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { isItemIssuanceArgs } from './itemAccess'
import { issuanceSigner } from './publicIdentities'
import { appendIssuerMetadata } from './issuerMetadata'
import { parseOrdEnvelope } from './ordinalOwnership'
import { rememberBeefBinary } from './beefCache'
import {
  enrichCreateActionForBsv21Issuer,
  isBsv21IdentityMintArgs,
  isBsv21SigmaDeployOutput,
  sigmaSignDeployLockingScript,
  completeBsv21SignableWithRootP2pkh,
} from './token/issuer'

type Args = Parameters<typeof enrichCreateActionForBsv21Issuer>[1]
export function isIdentityIssuanceArgs(method: string, args: unknown): boolean {
  return (
    isBsv21IdentityMintArgs(method, args) || isItemIssuanceArgs(method, args)
  )
}

/** Standard 1Sat SDK anchor pattern: noSend anchor → vin-bound Sigma → sendWith. */
export async function withSigmaAnchor(
  active: ActiveWallet,
  args: Args,
): Promise<Args> {
  if (args.inputs?.length) return args
  const lock = new P2PKH()
    .lock(PublicKey.fromString(active.identityKey).toAddress())
    .toHex()
  const anchor = await active.wallet.createAction({
    description: 'Sigma issuer anchor',
    outputs: [
      {
        lockingScript: lock,
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
  return {
    ...args,
    inputs: [
      {
        outpoint: `${anchor.txid}.0`,
        inputDescription: 'Sigma issuer anchor',
        unlockingScriptLength: 108,
      },
    ],
    inputBEEF: Array.from(anchor.tx),
    options: {
      ...args.options,
      randomizeOutputs: false,
      noSendChange: anchor.noSendChange,
      knownTxids: [anchor.txid],
      sendWith: [anchor.txid],
      trustSelf: 'known',
      acceptDelayedBroadcast: true,
    },
  }
}

export async function enrichIdentityIssuance(
  runtime: WalletRuntime,
  args: Args,
  expectedIssuer?: string,
): Promise<Args> {
  if (!runtimeIsCurrent(runtime))
    throw new Error('Wallet changed; approve again.')
  const active = runtime.instance
  const isOrdinal = (out: NonNullable<Args['outputs']>[number]) =>
    out.satoshis === 1 && out.basket?.trim().toLowerCase() === '1sat'
  const nft =
    isItemIssuanceArgs('createAction', args) && !!args.outputs?.some(isOrdinal)
  if (!nft && !isBsv21IdentityMintArgs('createAction', args)) return args
  const signer = signerWithIdentity(runtime, expectedIssuer)
  const targets = (args.outputs ?? []).filter(
    (out) => (nft && isOrdinal(out)) || isBsv21SigmaDeployOutput(out),
  )
  // Validate new inscriptions before making a durable anchor transaction.
  if (
    nft &&
    targets
      .filter(isOrdinal)
      .some((out) => !out.lockingScript || !parseOrdEnvelope(out.lockingScript))
  )
    throw new Error('A new collectable must contain a valid ord inscription.')
  const funded = targets.length ? await withSigmaAnchor(active, args) : args
  try {
    const signed = await signIssuance(runtime, funded, signer, nft, isOrdinal)
    if (funded !== args) anchors.set(signed, funded.inputs![0]!.outpoint)
    return signed
  } catch (err) {
    if (funded !== args) await abortQuietly(active, funded.inputs![0]!.outpoint.split('.')[0]!)
    throw err
  }
}

type IdentitySigner = ReturnType<typeof issuanceSigner> & {
  identity: NonNullable<ReturnType<typeof issuanceSigner>['identity']>
}

function signerWithIdentity(runtime: WalletRuntime, expectedIssuer?: string): IdentitySigner {
  const signer = issuanceSigner(runtime, expectedIssuer)
  if (!signer.identity)
    throw new Error(
      'Publish your issuer identity under ID → Public identities before issuing assets.',
    )
  return signer as IdentitySigner
}

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
  nft: boolean,
  isOrdinal: (out: NonNullable<Args['outputs']>[number]) => boolean,
): Promise<Args> {
  const active = runtime.instance
  // Selection/account can change while anchor creation waits. Never sign with
  // a different key from the one the user saw in the approval.
  if (signerWithIdentity(runtime, signer.selected).identityKey !== signer.identityKey)
    throw new Error('Issuer identity changed after approval; approve again.')
  const funded = await enrichCreateActionForBsv21Issuer(active, args, signer)
  if (!nft) return funded
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
      const customInstructions = JSON.stringify({
        ...ci,
        issuer: signer.identityKey,
        bapId: signer.bapId,
      })
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
        lockingScript: sigmaSignDeployLockingScript({
          lockingScriptHex: appendIssuerMetadata(
            out.lockingScript!,
            signer.identityKey,
            signer.bapId,
          ),
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
  const completed = await completeBsv21SignableWithRootP2pkh(
    active,
    row.signableTransaction,
    args.inputs.map((input) => input.outpoint),
  )
  const { signableTransaction: _drop, ...rest } = row
  return { ...rest, ...completed }
}
