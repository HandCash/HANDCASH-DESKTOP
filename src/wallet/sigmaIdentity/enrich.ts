/**
 * Stamp a Sigma identity onto a 1Sat or BSV-21 createAction output.
 *
 * The ordinal envelope stays as the asset. A short issuer JSON and a BSM
 * Sigma tail are appended, bound to VIN 0. Without a known funding input the
 * output is left unsigned — a tag is not a signature.
 */

import type { ActiveWallet } from '../session'
import { issuerStamp } from './actions'
import { listSigmaIdentities, signingSigmaIdentity } from './catalog'
import { SIGMA_MARKER_HEX } from './constants'
import { deriveSigmaIdentityPrivateKey } from './paths'
import { sigmaIdentityRequestFromOutput } from './request'
import { appendSigmaAttestation } from './script'

type Output = {
  lockingScript?: string
  basket?: string
  tags?: string[]
  customInstructions?: string
  satoshis?: number
  outputDescription?: string
}

type ActionArgs = {
  inputs?: Array<{ outpoint: string }>
  outputs?: Output[]
  options?: Record<string, unknown>
}

function mergeCi(existing: string | undefined, stamp: string): string {
  let prior: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prior = parsed as Record<string, unknown>
      }
    } catch {
      prior = {}
    }
  }
  const next = JSON.parse(stamp) as Record<string, unknown>
  return JSON.stringify({ ...prior, ...next })
}

function appFor(out: Output): '1sat_nft' | 'bsv21' {
  const basket = (out.basket ?? '').trim().toLowerCase()
  if (basket === 'bsv21') return 'bsv21'
  return '1sat_nft'
}

export async function enrichCreateActionForSigmaIdentity(
  active: ActiveWallet,
  args: ActionArgs,
): Promise<ActionArgs> {
  const outputs = args.outputs
  if (!outputs?.length) return args
  const requests = outputs.map((out) => sigmaIdentityRequestFromOutput(out))
  if (!requests.some(Boolean)) return args

  const bind = (args.inputs?.[0]?.outpoint ?? '').trim().toLowerCase().replace('_', '.')
  const [bindTxid = '', bindVoutRaw = ''] = bind.split('.')
  const bindVout = Number(bindVoutRaw)
  const canBind = /^[0-9a-f]{64}$/.test(bindTxid) && Number.isInteger(bindVout) && bindVout >= 0

  const personas = listSigmaIdentities(active.identityKey)
  const fallback = signingSigmaIdentity(active.identityKey)
  const next = outputs.map((out) => ({ ...out, tags: [...(out.tags ?? [])] }))

  for (let i = 0; i < next.length; i++) {
    const request = requests[i]
    if (!request) continue
    const personaId = request.personaId ?? fallback?.id ?? null
    if (!personaId) {
      console.info('[sigma-identity] output asked for a persona but none is selected')
      continue
    }
    const known = personas.find((row) => row.id === personaId && row.status === 'active')
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: active.rootKeyHex,
      personaId,
      generation: request.generation,
    })
    const publicKey = signer.toPublicKey().toString().toLowerCase()
    const stamp = issuerStamp({
      personaId,
      publicKey,
      identityKey: active.identityKey,
      generation: request.generation,
      name: request.name ?? known?.name,
      origin: known?.origin,
      app: appFor(next[i]!),
    })
    const out = next[i]!
    const tags = out.tags ?? []
    if (!tags.some((tag) => tag.startsWith('sigma-identity:'))) {
      tags.push(`sigma-identity:${personaId}`)
    }
    if (!tags.some((tag) => tag.startsWith('issuer:'))) {
      tags.push(`issuer:${publicKey}`)
    }
    out.tags = tags
    out.customInstructions = mergeCi(out.customInstructions, stamp.customInstructions)

    const locking = out.lockingScript?.trim().toLowerCase()
    if (!locking || locking.includes(SIGMA_MARKER_HEX) || !canBind) {
      if (!canBind) {
        console.info(
          '[sigma-identity] no VIN 0 outpoint to bind; issuer context stamped, signature skipped',
        )
      }
      continue
    }
    try {
      out.lockingScript = appendSigmaAttestation({
        lockingScriptHex: locking,
        fundTxid: bindTxid,
        fundVout,
        signer,
        vin: 0,
        metadataJson: stamp.metadataJson,
      })
    } catch (err) {
      console.warn('[sigma-identity] sign failed', err)
    }
  }

  return { ...args, outputs: next }
}
