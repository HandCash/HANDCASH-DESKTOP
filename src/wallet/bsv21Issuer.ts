/**
 * BSV-21 issuer attestation (BRC-163): on-chain Sigma + CI/tag mirror.
 *
 * Proof = Sigma on the deploy tip (1Sat / js-1sat-ord compatible).
 * `customInstructions.issuer` and tag `issuer:<pubkey>` are remittance mirrors only.
 */

import { PrivateKey, PublicKey, Script, Transaction } from '@bsv/sdk'
import { Algorithm, Sigma } from 'sigma-protocol'
import { buildMergedInputBeef } from './beefCache'
import type { ActiveWallet } from './session'

const PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/i

export function normalizeIssuerPubKey(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  return PUBKEY_RE.test(hex) ? hex : null
}

export function shortIssuerLabel(issuer: string): string {
  const id = normalizeIssuerPubKey(issuer) ?? issuer.trim().toLowerCase()
  if (id.length < 12) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

/** Issuer pubkey from CI and/or `issuer:<pubkey>` tag. */
export function issuerFromRemittance(args: {
  customInstructions?: string | null
  tags?: string[]
}): string | null {
  if (args.customInstructions) {
    try {
      const o = JSON.parse(args.customInstructions) as { issuer?: unknown }
      const fromCi = normalizeIssuerPubKey(
        typeof o.issuer === 'string' ? o.issuer : null,
      )
      if (fromCi) return fromCi
    } catch {
      // ignore
    }
  }
  for (const tag of args.tags ?? []) {
    if (!tag.startsWith('issuer:')) continue
    const pk = normalizeIssuerPubKey(tag.slice('issuer:'.length))
    if (pk) return pk
  }
  return null
}

/**
 * Read Sigma metadata from a locking script (no full-tx verify).
 * Matches `candidatePubKeys` by P2PKH address embedded in the Sigma fields.
 * Full verification requires the broadcast transaction (vin binding).
 */
export function issuerFromSigmaLockingScript(
  lockingScriptHex: string,
  candidatePubKeys: string[] = [],
): { issuer: string | null; verified: boolean; algorithm?: string; address?: string } {
  const hex = lockingScriptHex.trim().toLowerCase()
  // "SIGMA" as UTF-8 push data
  if (!hex || !hex.includes('5349474d41')) {
    return { issuer: null, verified: false }
  }
  try {
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
    })
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex(hex),
    })
    const sigma = new Sigma(tx, 0, 0, 0)
    const sig = sigma.sig
    if (!sig?.address) return { issuer: null, verified: false }

    const algorithm = sig.algorithm === Algorithm.BRC77 ? 'BRC77' : 'BSM'

    for (const c of candidatePubKeys) {
      const pk = normalizeIssuerPubKey(c)
      if (!pk) continue
      if (PublicKey.fromString(pk).toAddress() === sig.address) {
        // Address match only — not vin-bound verify without the real tx.
        return { issuer: pk, verified: false, algorithm, address: sig.address }
      }
    }
    return {
      issuer: null,
      verified: false,
      algorithm,
      address: sig.address,
    }
  } catch (err) {
    console.warn('[bsv21-issuer] sigma parse failed', err)
    return { issuer: null, verified: false }
  }
}

/**
 * Append Sigma (BRC-77) to a deploy tip locking script, bound to funding vin 0.
 * Caller must ensure createAction spends `fundOutpoint` as input 0.
 */
export function sigmaSignDeployLockingScript(args: {
  lockingScriptHex: string
  fundTxid: string
  fundVout: number
  identityKeyHex: string
}): string {
  const root = PrivateKey.fromHex(args.identityKeyHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: args.fundTxid.toLowerCase(),
    sourceOutputIndex: args.fundVout,
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: Script.fromHex(args.lockingScriptHex.trim().toLowerCase()),
  })
  const sigma = new Sigma(tx, 0, 0, 0)
  const { signedTx } = sigma.sign(root, Algorithm.BRC77)
  const script = signedTx.outputs[0]?.lockingScript?.toHex()
  if (!script) throw new Error('Sigma sign produced no locking script')
  return script.toLowerCase()
}

type CreateActionOutput = {
  lockingScript?: string
  satoshis?: number
  outputDescription?: string
  basket?: string
  tags?: string[]
  customInstructions?: string
}

type CreateActionArgs = {
  description?: string
  labels?: string[]
  inputs?: Array<{
    outpoint: string
    inputDescription?: string
    unlockingScriptLength?: number
  }>
  inputBEEF?: number[]
  outputs?: CreateActionOutput[]
  options?: Record<string, unknown>
}

/** True when an output is a BSV-21 deploy+mint tip (basket + op). */
export function isBsv21DeployMintOutput(out: CreateActionOutput): boolean {
  const basket = (out.basket ?? '').trim().toLowerCase()
  if (basket !== 'bsv21') return false
  const ci = (out.customInstructions ?? '').toLowerCase()
  if (ci.includes('deploy+mint')) return true
  return (out.tags ?? []).some((t) => t.toLowerCase() === 'op:deploy+mint')
}

/**
 * True when createAction will mint a BSV-21 token that HandCash backs with the
 * user's identity (CI/tag issuer + Sigma on approve).
 */
export function isBsv21IdentityMintArgs(method: string, args: unknown): boolean {
  if (method !== 'createAction') return false
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const outputs = (args as CreateActionArgs).outputs
  if (!Array.isArray(outputs) || outputs.length === 0) return false
  return outputs.some((o) => isBsv21DeployMintOutput(o))
}

/** Best-effort symbol / amount from deploy+mint tags or customInstructions. */
export function bsv21IdentityMintHints(args: unknown): {
  sym: string | null
  amt: string | null
} {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { sym: null, amt: null }
  }
  const outputs = (args as CreateActionArgs).outputs ?? []
  for (const out of outputs) {
    if (!isBsv21DeployMintOutput(out)) continue
    let sym: string | null = null
    let amt: string | null = null
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('sym:') && !sym) sym = t.slice(4).trim() || null
      if (lower.startsWith('amt:') && !amt) amt = t.slice(4).trim() || null
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          sym?: unknown
          amt?: unknown
        }
        if (!sym && typeof ci.sym === 'string' && ci.sym.trim()) {
          sym = ci.sym.trim()
        }
        if (!amt && typeof ci.amt === 'string' && ci.amt.trim()) {
          amt = ci.amt.trim()
        }
      } catch {
        // ignore
      }
    }
    return { sym, amt }
  }
  return { sym: null, amt: null }
}

function mergeIssuerIntoCi(ci: string | undefined, issuer: string): string {
  let body: Record<string, unknown> = {}
  if (ci) {
    try {
      const parsed = JSON.parse(ci) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      body = {}
    }
  }
  body.issuer = issuer
  return JSON.stringify(body)
}

function normalizeDotOutpoint(op: string): string {
  const m = op
    .trim()
    .toLowerCase()
    .match(/^([0-9a-f]{64})[._](\d+)$/)
  if (!m) return op.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return `${m[1]}.${m[2]}`
}

/**
 * Enrich a BRC-100 createAction for basket `bsv21` deploy+mint:
 * - CI + tag issuer mirror
 * - Sigma-sign locking scripts bound to a wallet funding input as vin 0
 */
export async function enrichCreateActionForBsv21Issuer(
  active: ActiveWallet,
  args: CreateActionArgs,
): Promise<CreateActionArgs> {
  const outputs = args.outputs
  if (!outputs?.length) return args
  const deployIdxs = outputs
    .map((o, i) => (isBsv21DeployMintOutput(o) ? i : -1))
    .filter((i) => i >= 0)
  if (deployIdxs.length === 0) return args

  const issuer = normalizeIssuerPubKey(active.identityKey)
  if (!issuer) return args

  const nextOutputs = outputs.map((o) => ({ ...o }))
  for (const i of deployIdxs) {
    const out = nextOutputs[i]!
    const tags = [...(out.tags ?? [])]
    if (!tags.some((t) => t === 'bsv21' || t.startsWith('bsv21:'))) {
      tags.unshift('bsv21')
    }
    if (!tags.some((t) => t.startsWith('issuer:'))) {
      tags.push(`issuer:${issuer}`)
    }
    nextOutputs[i] = {
      ...out,
      tags,
      customInstructions: mergeIssuerIntoCi(out.customInstructions, issuer),
    }
  }

  // Funding input for Sigma vin-binding.
  let fundOutpoint: string | null = null
  let fundTxid = ''
  let fundVout = 0
  try {
    const listed = await active.wallet.listOutputs({
      basket: 'default',
      limit: 50,
    })
    // Any spendable default tip can bind Sigma as vin 0; prefer larger for fees.
    const fund = (listed.outputs ?? [])
      .filter((o) => (o.satoshis ?? 0) >= 1 && o.outpoint)
      .sort((a, b) => (b.satoshis ?? 0) - (a.satoshis ?? 0))[0]
    if (fund?.outpoint) {
      fundOutpoint = normalizeDotOutpoint(fund.outpoint)
      const [txid, voutS] = fundOutpoint.split('.')
      fundTxid = txid ?? ''
      fundVout = Number(voutS)
    }
  } catch (err) {
    console.warn('[bsv21-issuer] listOutputs for Sigma fund failed', err)
  }

  if (fundOutpoint && fundTxid && Number.isFinite(fundVout)) {
    for (const i of deployIdxs) {
      const out = nextOutputs[i]!
      if (!out.lockingScript) continue
      try {
        nextOutputs[i] = {
          ...out,
          lockingScript: sigmaSignDeployLockingScript({
            lockingScriptHex: out.lockingScript,
            fundTxid,
            fundVout,
            identityKeyHex: active.rootKeyHex,
          }),
        }
      } catch (err) {
        console.warn('[bsv21-issuer] Sigma sign failed; CI issuer only', err)
      }
    }

    const existingInputs = args.inputs ?? []
    const already =
      existingInputs.length > 0 &&
      normalizeDotOutpoint(existingInputs[0]!.outpoint) === fundOutpoint
    let inputs = existingInputs
    let inputBEEF = args.inputBEEF
    if (!already) {
      inputs = [
        {
          outpoint: fundOutpoint,
          inputDescription: 'bsv21 issuer Sigma fund',
          unlockingScriptLength: 108,
        },
        ...existingInputs,
      ]
      try {
        inputBEEF = await buildMergedInputBeef(
          active,
          [fundOutpoint],
          normalizeDotOutpoint,
        )
      } catch (err) {
        console.warn('[bsv21-issuer] inputBEEF failed; skipping forced fund input', err)
        inputs = existingInputs
      }
    }

    return {
      ...args,
      outputs: nextOutputs,
      inputs,
      ...(inputBEEF ? { inputBEEF } : {}),
      options: {
        ...(args.options ?? {}),
        // Keep deploy tip vout stable when possible; Sigma is in-script either way.
        randomizeOutputs: false,
      },
    }
  }

  return { ...args, outputs: nextOutputs }
}
