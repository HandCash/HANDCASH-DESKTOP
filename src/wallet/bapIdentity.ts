/**
 * BAP identity for the active vault account (1sat/Yours-compatible).
 *
 * Tree: protocolID [1, "sigma"] / keyID identity-{N}
 * Basket: bap
 * Compose = publish ID (if needed) + ALIAS profile in one createAction.
 */
import {
  BSM,
  BigNumber,
  Hash,
  OP,
  PublicKey,
  Script,
  Signature,
  Utils,
} from '@bsv/sdk'
import { getActiveWallet } from './session'

export const BAP_PROTOCOL_ID: [1, 'sigma'] = [1, 'sigma']
export const BAP_KEY_ID = 'identity'
export const BAP_BASKET = 'bap'
export const BAP_BITCOM_ADDRESS = '1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT'
const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const AIP_ALGORITHM = 'BITCOIN_ECDSA'

const { toArray, toBase58, toHex } = Utils

export type BapProfile = {
  '@type'?: string
  name?: string
  description?: string
  image?: string
  [key: string]: unknown
}

export type BapComposeResult =
  | { ok: true; txid: string; bapId: string; createdIdentity: boolean }
  | { ok: false; error: string }

function signingKeyId(index: number): string {
  return `${BAP_KEY_ID}-${index}`
}

function activeWalletOrThrow() {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet is locked.')
  return active
}

async function deriveAddress(keyID: string): Promise<string> {
  const { wallet } = activeWalletOrThrow()
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BAP_PROTOCOL_ID,
    keyID,
    counterparty: 'self',
  })
  return PublicKey.fromString(publicKey).toAddress()
}

/** BAP ID = base58(ripemd160(sha256(identity-0.address))) */
export async function computeBapId(): Promise<string> {
  const address = await deriveAddress(signingKeyId(0))
  return toBase58(Hash.ripemd160(toHex(Hash.sha256(address, 'utf8')), 'hex'))
}

export async function resolvePublishedBapId(): Promise<string | null> {
  const { wallet } = activeWalletOrThrow()
  const result = await wallet.listOutputs({
    basket: BAP_BASKET,
    tags: ['type:id'],
    limit: 1,
  })
  if (!result.outputs.length) return null
  return computeBapId()
}

async function resolveCurrentKeyId(): Promise<string> {
  const { wallet } = activeWalletOrThrow()
  const result = await wallet.listOutputs({
    basket: BAP_BASKET,
    tags: ['type:id'],
    includeTags: true,
    limit: 100,
  })
  let maxSeq = 0
  for (const output of result.outputs) {
    const seqTag = output.tags?.find((t) => t.startsWith('seq:'))
    if (!seqTag) continue
    const seq = Number.parseInt(seqTag.slice(4), 10)
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
  }
  if (maxSeq < 1) {
    throw new Error('No BAP identity published — publish first.')
  }
  return signingKeyId(maxSeq)
}

function aipMessageBuffer(lockingScript: Script): number[] {
  const buf: number[] = []
  let foundOpReturn = false
  let hasContent = false
  for (const chunk of lockingScript.chunks) {
    if (chunk.op === OP.OP_RETURN) {
      buf.push(OP.OP_RETURN)
      foundOpReturn = true
      continue
    }
    if (!foundOpReturn) continue
    if (chunk.data != null && chunk.data.length > 0) {
      buf.push(...Array.from(chunk.data))
      hasContent = true
    }
  }
  if (hasContent) buf.push(0x7c)
  return buf
}

async function applyBapAip(lockingScript: Script, keyID: string): Promise<Script> {
  const { wallet } = activeWalletOrThrow()
  const message = aipMessageBuffer(lockingScript)
  const msgHash = BSM.magicHash(message)

  const sigResult = await wallet.createSignature({
    protocolID: BAP_PROTOCOL_ID,
    keyID,
    counterparty: 'self',
    hashToDirectlySign: Array.from(msgHash),
  })
  const pub = await wallet.getPublicKey({
    protocolID: BAP_PROTOCOL_ID,
    keyID,
    counterparty: 'self',
    forSelf: true,
  })
  const publicKey = PublicKey.fromString(pub.publicKey)
  const signature = Signature.fromDER(sigResult.signature)
  const recovery = signature.CalculateRecoveryFactor(
    publicKey,
    new BigNumber(msgHash),
  )
  const compactB64 = signature.toCompact(recovery, true, 'base64') as string
  const address = publicKey.toAddress()

  const out = new Script(lockingScript.chunks.slice())
  out.writeBin(toArray('|'))
  out.writeBin(toArray(AIP_PREFIX))
  out.writeBin(toArray(AIP_ALGORITHM))
  out.writeBin(toArray(address))
  out.writeBin(toArray(compactB64, 'base64'))
  return out
}

async function buildIdOutput(args: {
  bapId: string
  seq: number
  signerKeyId: string
  declareKeyId: string
}): Promise<{
  lockingScript: string
  tags: string[]
  customInstructions: string
}> {
  const declareAddress = await deriveAddress(args.declareKeyId)
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  script.writeBin(toArray(BAP_BITCOM_ADDRESS))
  script.writeBin(toArray('ID'))
  script.writeBin(toArray(args.bapId))
  script.writeBin(toArray(declareAddress))
  const signed = await applyBapAip(script, args.signerKeyId)
  return {
    lockingScript: signed.toHex(),
    tags: ['type:id', `bapId:${args.bapId}`, `seq:${args.seq}`],
    customInstructions: JSON.stringify({
      protocolID: BAP_PROTOCOL_ID,
      keyID: args.declareKeyId,
    }),
  }
}

function parseAliasProfile(lockingScriptHex: string): {
  bapId: string
  profile: BapProfile
} | null {
  try {
    const script = Script.fromHex(lockingScriptHex)
    const pushes: string[] = []
    let afterReturn = false
    for (const chunk of script.chunks) {
      if (chunk.op === OP.OP_RETURN) {
        afterReturn = true
        continue
      }
      if (!afterReturn) continue
      if (chunk.data == null || chunk.data.length === 0) continue
      const s = Utils.toUTF8(Array.from(chunk.data))
      if (s === '|') break
      pushes.push(s)
    }
    // bitcom, ALIAS, bapId, json
    const aliasIdx = pushes.findIndex((p) => p === 'ALIAS')
    if (aliasIdx < 0 || pushes.length < aliasIdx + 3) return null
    const bapId = pushes[aliasIdx + 1]!
    const profile = JSON.parse(pushes[aliasIdx + 2]!) as BapProfile
    return { bapId, profile }
  } catch {
    return null
  }
}

export async function getBapProfile(): Promise<{
  bapId: string | null
  published: boolean
  profile: BapProfile | null
}> {
  const { wallet } = activeWalletOrThrow()
  const idRows = await wallet.listOutputs({
    basket: BAP_BASKET,
    tags: ['type:id'],
    limit: 1,
  })
  const published = idRows.outputs.length > 0
  const bapId = published ? await computeBapId() : await computeBapId()

  const aliasScan = await wallet.listOutputs({
    basket: BAP_BASKET,
    tags: ['type:alias'],
    include: 'locking scripts',
    includeTags: true,
    limit: 100,
  })
  if (!aliasScan.outputs.length) {
    return { bapId: published ? bapId : null, published, profile: null }
  }

  // Prefer newest publishedAt tag when present
  let best = aliasScan.outputs[0]!
  let bestAt = -1
  for (const row of aliasScan.outputs) {
    const tag = row.tags?.find((t) => t.startsWith('publishedAt:'))
    const at = tag ? Number.parseInt(tag.slice('publishedAt:'.length), 10) : 0
    if (at >= bestAt) {
      bestAt = at
      best = row
    }
  }
  if (!best.lockingScript) {
    return { bapId: published ? bapId : null, published, profile: null }
  }
  const parsed = parseAliasProfile(best.lockingScript)
  return {
    bapId: parsed?.bapId ?? (published ? bapId : null),
    published,
    profile: parsed?.profile ?? null,
  }
}

/**
 * Compose / update on-chain identity: ensure BAP ID exists, write ALIAS profile.
 * Matches 1sat-sdk updateProfile (ID+ALIAS on first publish).
 */
export async function composeBapIdentity(profile: BapProfile): Promise<BapComposeResult> {
  try {
    const active = activeWalletOrThrow()
    const { wallet } = active
    const existingId = await resolvePublishedBapId()
    const bapId = existingId ?? (await computeBapId())
    const publishedAtTag = `publishedAt:${Date.now()}`

    const existingAliases = await wallet.listOutputs({
      basket: BAP_BASKET,
      tags: ['type:alias'],
      limit: 100,
    })

    const aliasScript = new Script()
    aliasScript.writeOpCode(OP.OP_FALSE)
    aliasScript.writeOpCode(OP.OP_RETURN)
    aliasScript.writeBin(toArray(BAP_BITCOM_ADDRESS))
    aliasScript.writeBin(toArray('ALIAS'))
    aliasScript.writeBin(toArray(bapId))
    aliasScript.writeBin(toArray(JSON.stringify(profile)))

    const outputs: Array<{
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket: string
      tags: string[]
      customInstructions?: string
    }> = []

    let createdIdentity = false
    if (!existingId) {
      createdIdentity = true
      const rootKeyId = signingKeyId(0)
      const firstSigningKeyId = signingKeyId(1)
      const idOutput = await buildIdOutput({
        bapId,
        seq: 1,
        signerKeyId: rootKeyId,
        declareKeyId: firstSigningKeyId,
      })
      outputs.push({
        lockingScript: idOutput.lockingScript,
        satoshis: 1,
        outputDescription: 'BAP ID',
        basket: BAP_BASKET,
        tags: idOutput.tags,
        customInstructions: idOutput.customInstructions,
      })
      const signedAlias = await applyBapAip(aliasScript, firstSigningKeyId)
      outputs.push({
        lockingScript: signedAlias.toHex(),
        satoshis: 1,
        outputDescription: 'BAP ALIAS',
        basket: BAP_BASKET,
        tags: ['type:alias', `bapId:${bapId}`, publishedAtTag],
      })
    } else {
      const keyId = await resolveCurrentKeyId()
      const signedAlias = await applyBapAip(aliasScript, keyId)
      outputs.push({
        lockingScript: signedAlias.toHex(),
        satoshis: 1,
        outputDescription: 'BAP ALIAS',
        basket: BAP_BASKET,
        tags: ['type:alias', `bapId:${bapId}`, publishedAtTag],
      })
    }

    const result = await wallet.createAction({
      description: existingId ? 'BAP alias update' : 'BAP identity creation with profile',
      labels: ['handcash-bap', 'bap-identity'],
      outputs,
      options: {
        acceptDelayedBroadcast: true,
        signAndProcess: true,
        randomizeOutputs: false,
      },
    })

    const txid = (result as { txid?: string }).txid
    if (!txid) return { ok: false, error: 'No txid returned — check balance and try again.' }

    for (const old of existingAliases.outputs) {
      try {
        await wallet.relinquishOutput({
          basket: BAP_BASKET,
          output: old.outpoint,
        })
      } catch {
        // leave stale
      }
    }

    return { ok: true, txid, bapId, createdIdentity }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Deterministic BAP ID preview without requiring publish (identity-0). */
export async function previewBapId(): Promise<string> {
  return computeBapId()
}

