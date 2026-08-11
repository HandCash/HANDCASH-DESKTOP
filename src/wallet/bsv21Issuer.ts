/**
 * BSV-21 issuer attestation (BRC-163): on-chain Sigma + CI/tag mirror.
 *
 * Proof = Sigma on the deploy tip (1Sat / js-1sat-ord compatible).
 * `customInstructions.issuer` and tag `issuer:<pubkey>` are remittance mirrors only.
 */

import { Beef, P2PKH, PrivateKey, PublicKey, Script, Transaction } from '@bsv/sdk'
import { Algorithm, Sigma } from 'sigma-protocol'
import { buildMergedInputBeef, rememberBeefBinary, asTrustSelfInputBeef } from './beefCache'
import { normalizeTokenId } from './bsv21'
import { fetchRawTxHex } from './oneSatImport'
import { parseOrdEnvelope } from './ordinalOwnership'
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

function bsv21OpFromOutput(out: CreateActionOutput): string | null {
  for (const tag of out.tags ?? []) {
    const t = tag.trim().toLowerCase()
    if (t.startsWith('op:')) return t.slice(3) || null
  }
  if (out.customInstructions) {
    try {
      const ci = JSON.parse(out.customInstructions) as { op?: unknown }
      if (typeof ci.op === 'string') return ci.op.trim().toLowerCase()
    } catch {
      // ignore
    }
  }
  return null
}

/** True when an output is a BSV-21 deploy+mint tip (basket + op). */
export function isBsv21DeployMintOutput(out: CreateActionOutput): boolean {
  const basket = (out.basket ?? '').trim().toLowerCase()
  if (basket !== 'bsv21') return false
  return bsv21OpFromOutput(out) === 'deploy+mint'
}

/** Genesis or mint tips HandCash backs with identity (CI/tag issuer ± Sigma). */
export function isBsv21IdentityIssuanceOutput(out: CreateActionOutput): boolean {
  const basket = (out.basket ?? '').trim().toLowerCase()
  if (basket !== 'bsv21') return false
  const op = bsv21OpFromOutput(out)
  return op === 'deploy+mint' || op === 'deploy+auth' || op === 'mint'
}

/** Deploy tips that receive Sigma (genesis only). */
export function isBsv21SigmaDeployOutput(out: CreateActionOutput): boolean {
  const basket = (out.basket ?? '').trim().toLowerCase()
  if (basket !== 'bsv21') return false
  const op = bsv21OpFromOutput(out)
  return op === 'deploy+mint' || op === 'deploy+auth'
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
  return outputs.some((o) => isBsv21IdentityIssuanceOutput(o))
}

/** Best-effort symbol / amount from identity-mint tags or customInstructions. */
export function bsv21IdentityMintHints(args: unknown): {
  sym: string | null
  amt: string | null
} {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { sym: null, amt: null }
  }
  const outputs = (args as CreateActionArgs).outputs ?? []
  let sym: string | null = null
  let amt: string | null = null
  for (const out of outputs) {
    if (!isBsv21IdentityIssuanceOutput(out)) continue
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
  }
  return { sym, amt }
}

function mergeIssuerIntoCi(
  ci: string | undefined,
  issuer: string,
  extra?: { icon?: string },
): string {
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
  if (extra?.icon && !body.icon) body.icon = extra.icon
  return JSON.stringify(body)
}

function iconFromCi(ci: string | undefined): string | null {
  if (!ci) return null
  try {
    const o = JSON.parse(ci) as { icon?: unknown }
    if (typeof o.icon !== 'string') return null
    return normalizeTokenId(o.icon)
  } catch {
    return null
  }
}

function pushDataHex(data: Uint8Array): string {
  const n = data.length
  const body = [...data].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (n <= 75) return n.toString(16).padStart(2, '0') + body
  if (n <= 255) return `4c${n.toString(16).padStart(2, '0')}${body}`
  if (n <= 65535) {
    const lo = (n & 0xff).toString(16).padStart(2, '0')
    const hi = ((n >> 8) & 0xff).toString(16).padStart(2, '0')
    return `4d${lo}${hi}${body}`
  }
  throw new Error('Inscription payload too large')
}

/**
 * Inject `icon` into a deploy+mint / deploy+auth inscription locking script when missing.
 * Preserves the trailing P2PKH. Returns null when unchanged / not applicable.
 */
export function injectIconIntoBsv21DeployScript(
  lockingScriptHex: string,
  iconOutpoint: string,
): string | null {
  const icon = normalizeTokenId(iconOutpoint)
  if (!icon) return null
  const hex = lockingScriptHex.trim().toLowerCase()
  const env = parseOrdEnvelope(hex)
  if (!env?.body?.length) return null
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(new TextDecoder().decode(env.body)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    json = { ...(parsed as Record<string, unknown>) }
  } catch {
    return null
  }
  if (json.p !== 'bsv-20') return null
  if (json.op !== 'deploy+mint' && json.op !== 'deploy+auth') return null
  if (typeof json.icon === 'string' && normalizeTokenId(json.icon)) return null

  json.icon = icon
  const p2pkh = hex.match(/(76a914[0-9a-f]{40}88ac)$/)?.[1]
  if (!p2pkh) return null

  const enc = new TextEncoder()
  const mime = env.contentType?.trim() || 'application/bsv-20'
  const envelope =
    '00' +
    '63' +
    pushDataHex(enc.encode('ord')) +
    '51' +
    pushDataHex(enc.encode(mime)) +
    '00' +
    pushDataHex(enc.encode(JSON.stringify(json))) +
    '68'
  return (envelope + p2pkh).toLowerCase()
}

/**
 * Reuse a prior on-chain icon for the same issuer + symbol from basket tips.
 */
export async function findPriorBsv21Icon(
  active: ActiveWallet,
  sym: string,
  issuer: string,
): Promise<string | null> {
  const wantSym = sym.trim().toUpperCase()
  const wantIssuer = normalizeIssuerPubKey(issuer)
  if (!wantSym || !wantIssuer) return null
  try {
    const listed = await active.wallet.listOutputs({
      basket: 'bsv21',
      limit: 100,
      includeCustomInstructions: true,
      includeTags: true,
    })
    for (const o of listed.outputs ?? []) {
      const tipIssuer = issuerFromRemittance({
        customInstructions: o.customInstructions,
        tags: o.tags,
      })
      if (tipIssuer !== wantIssuer) continue

      let tipSym: string | null = null
      for (const tag of o.tags ?? []) {
        const t = tag.trim()
        if (t.toLowerCase().startsWith('sym:')) {
          tipSym = t.slice(4).trim().toUpperCase() || null
          break
        }
      }
      let tipIcon = iconFromCi(o.customInstructions)
      if (o.customInstructions) {
        try {
          const ci = JSON.parse(o.customInstructions) as { sym?: unknown }
          if (!tipSym && typeof ci.sym === 'string' && ci.sym.trim()) {
            tipSym = ci.sym.trim().toUpperCase()
          }
        } catch {
          // ignore
        }
      }
      if (tipSym === wantSym && tipIcon) return tipIcon
    }
  } catch (err) {
    console.warn('[bsv21-issuer] prior icon lookup failed', err)
  }
  return null
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
 * Enrich a BRC-100 createAction for basket `bsv21` identity issuance:
 * - CI + tag issuer mirror on deploy+mint / deploy+auth / mint
 * - Sigma-sign genesis locking scripts (deploy+mint / deploy+auth) bound to vin 0
 */
export async function enrichCreateActionForBsv21Issuer(
  active: ActiveWallet,
  args: CreateActionArgs,
): Promise<CreateActionArgs> {
  const outputs = args.outputs
  if (!outputs?.length) return args
  const issuanceIdxs = outputs
    .map((o, i) => (isBsv21IdentityIssuanceOutput(o) ? i : -1))
    .filter((i) => i >= 0)
  if (issuanceIdxs.length === 0) return args

  const issuer = normalizeIssuerPubKey(active.identityKey)
  if (!issuer) return args

  const nextOutputs = outputs.map((o) => ({ ...o }))

  const deployIdxs = nextOutputs
    .map((o, i) => (isBsv21SigmaDeployOutput(o) ? i : -1))
    .filter((i) => i >= 0)
  const allIssuanceIdxs = issuanceIdxs

  // Reuse a prior icon for the same issuer+sym when genesis omitted it.
  const priorIconBySym = new Map<string, string | null>()
  for (const i of deployIdxs) {
    const out = nextOutputs[i]!
    if (iconFromCi(out.customInstructions)) continue
    const sym = symFromOutput(out)
    if (!sym) continue
    const key = sym.toUpperCase()
    if (!priorIconBySym.has(key)) {
      priorIconBySym.set(key, await findPriorBsv21Icon(active, sym, issuer))
    }
    const prior = priorIconBySym.get(key)
    if (!prior) continue

    let lockingScript = out.lockingScript
    if (lockingScript) {
      try {
        const injected = injectIconIntoBsv21DeployScript(lockingScript, prior)
        if (injected) lockingScript = injected
      } catch (err) {
        console.warn('[bsv21-issuer] icon inject into locking script failed', err)
      }
    }
    nextOutputs[i] = {
      ...out,
      lockingScript,
      customInstructions: mergeIssuerIntoCi(out.customInstructions, issuer, {
        icon: prior,
      }),
    }
  }

  for (const i of allIssuanceIdxs) {
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

  // Funding input for Sigma vin-binding (genesis deploy only).
  let fundOutpoint: string | null = null
  let fundTxid = ''
  let fundVout = 0
  if (deployIdxs.length > 0) {
    try {
      const listed = await active.wallet.listOutputs({
        basket: 'default',
        limit: 50,
      })
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
  }

  let inputs = [...(args.inputs ?? [])]
  let inputBEEF = args.inputBEEF

  if (fundOutpoint && fundTxid && Number.isFinite(fundVout) && deployIdxs.length > 0) {
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

    const already =
      inputs.length > 0 &&
      normalizeDotOutpoint(inputs[0]!.outpoint) === fundOutpoint
    if (!already) {
      inputs = [
        {
          outpoint: fundOutpoint,
          inputDescription: 'bsv21 issuer Sigma fund',
          unlockingScriptLength: 108,
        },
        ...inputs,
      ]
    }
  }

  // Auth remint / any explicit tip spend must carry source txs in inputBEEF —
  // otherwise the toolbox fails with "Every signableTransaction input must have
  // a sourceTransaction". Prefer caller BEEF (fresh deploy AtomicBEEF), then
  // session cache / indexer, then raw-tx wrap. Parents missing from a tip-only
  // wrap are patched as txidOnly so trustSelf:'known' can vouch for them.
  if (inputs.length > 0) {
    const beefOps = [
      ...new Set(inputs.map((i) => normalizeDotOutpoint(i.outpoint)).filter(Boolean)),
    ]
    inputBEEF = await ensureBsv21InputBeef(active, beefOps, args.inputBEEF)
    if (!inputBEEF) {
      throw new Error(
        'Could not load source transactions for the mint tip. Wait a moment after deploy, then mint again.',
      )
    }
  }

  // Same as collectables: declare tip/fund txids as known so fee UTXOs + tip
  // spends resolve sourceTransaction without waiting on the indexer.
  const knownTxids = [
    ...new Set(
      inputs
        .map((i) => normalizeDotOutpoint(i.outpoint).split('.')[0]?.toLowerCase())
        .filter((t): t is string => !!t),
    ),
  ]

  return {
    ...args,
    outputs: nextOutputs,
    ...(inputs.length ? { inputs } : {}),
    inputBEEF,
    options: {
      ...(args.options ?? {}),
      randomizeOutputs: false,
      trustSelf: 'known',
      ...(knownTxids.length > 0 ? { knownTxids } : {}),
      signAndProcess: true,
      acceptDelayedBroadcast: false,
    },
  }
}

function beefHasTx(beef: Beef, txid: string): boolean {
  return beef.findTxid(txid.trim().toLowerCase())?.tx != null
}

/**
 * Build inputBEEF covering every spend outpoint with raw tip bodies (required
 * for signable `sourceTransaction`). Caller BEEF first, then cache/indexer,
 * then raw-tx. Shape with txidOnly parents so `trustSelf:'known'` verify passes.
 */
async function ensureBsv21InputBeef(
  active: ActiveWallet,
  outpoints: string[],
  prefer?: number[],
): Promise<number[] | undefined> {
  const txids = [
    ...new Set(
      outpoints
        .map((op) => normalizeDotOutpoint(op).split('.')[0]?.toLowerCase())
        .filter((t): t is string => !!t),
    ),
  ]
  if (txids.length === 0) return undefined

  const merged = new Beef()
  if (prefer?.length) {
    try {
      merged.mergeBeef(prefer)
      merged.atomicTxid = undefined
    } catch (err) {
      console.warn('[bsv21-issuer] caller inputBEEF merge failed', err)
    }
  }

  const missing = () => txids.filter((txid) => !beefHasTx(merged, txid))
  let need = missing()

  if (need.length > 0) {
    try {
      const built = await Promise.race([
        buildMergedInputBeef(
          active,
          need.map((txid) => `${txid}.0`),
          normalizeDotOutpoint,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('inputBEEF timed out (indexer unreachable)')),
            8_000,
          ),
        ),
      ])
      merged.mergeBeef(built)
      merged.atomicTxid = undefined
    } catch (err) {
      console.warn('[bsv21-issuer] inputBEEF for tip spends failed', err)
    }
  }

  need = missing()
  if (need.length > 0) {
    await Promise.all(
      need.map(async (txid) => {
        try {
          const hex = await fetchRawTxHex(txid, active.chain)
          if (!hex) return
          const wrap = new Beef()
          wrap.mergeTransaction(Transaction.fromHex(hex))
          if (!wrap.findTxid(txid)?.tx) return
          // Keep tip body even when parents are absent — asTrustSelfInputBeef
          // will patch parents as txidOnly for trustSelf verify.
          merged.mergeBeef(wrap.toBinary())
          merged.atomicTxid = undefined
        } catch (err) {
          console.warn('[bsv21-issuer] raw-tx inputBEEF fallback failed', txid, err)
        }
      }),
    )
  }

  need = missing()
  if (need.length > 0) {
    console.warn(
      '[bsv21-issuer] incomplete inputBEEF — missing tip raw txs:',
      need.join(', '),
    )
    return undefined
  }

  const shaped = asTrustSelfInputBeef(merged)
  if (shaped) {
    for (const txid of txids) rememberBeefBinary(txid, shaped)
    return shaped
  }

  console.warn(
    '[bsv21-issuer] inputBEEF could not be shaped for trustSelf',
    merged.toLogString?.() ?? '',
  )
  return undefined
}

export type Bsv21SignableTransaction = {
  tx: number[]
  reference: string
}

/**
 * Auth tips / Sigma fund inputs use `unlockingScriptLength`, so createAction
 * returns `signableTransaction` without a txid. Complete with root-key P2PKH
 * (same pattern as soft-latch collectable sends).
 */
export async function completeBsv21SignableWithRootP2pkh(
  active: ActiveWallet,
  signable: Bsv21SignableTransaction,
  inputOutpoints: string[],
): Promise<{ txid: string; tx?: number[] }> {
  const targets = new Set(
    inputOutpoints
      .map((op) => normalizeDotOutpoint(op))
      .filter(Boolean)
      .map((op) => {
        const [txid, vout] = op.split('.')
        return `${txid}.${Number(vout)}`
      }),
  )
  if (targets.size === 0) {
    throw new Error('BSV-21 mint signable has no inputs to unlock')
  }

  const beef = Beef.fromBinary(signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${input?.sourceOutputIndex}`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('BSV-21 auth input missing from the signable transaction')
  }

  const rootKey = PrivateKey.fromHex(active.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const sourceOut =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]
    const satoshis = sourceOut?.satoshis
    const lockingScript = sourceOut?.lockingScript
    if (typeof satoshis !== 'number' || !lockingScript) {
      throw new Error('BSV-21 mint input is missing its source transaction')
    }
    // Auth tips are inscription ‖ P2PKH ‖ Sigma — sighash scriptCode must be the
    // full locking script. SetupClient.getUnlockP2PKH only hashes plain P2PKH
    // and fails CHECKSIG on ordinal tips (soft-latch dust is plain P2PKH).
    input.unlockingScriptTemplate = new P2PKH().unlock(
      rootKey,
      'all',
      false,
      satoshis,
      lockingScript,
    )
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign the BSV-21 mint input')
    spends[vin] = { unlockingScript }
  }

  const signed = await active.wallet.signAction({
    reference: signable.reference,
    spends,
  })
  const txid =
    typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!txid) throw new Error('BSV-21 mint signAction returned no txid')

  let txBinary: number[] | undefined = Array.isArray(signed.tx)
    ? (signed.tx as number[])
    : undefined
  if (!txBinary) {
    try {
      // Cache parents + newly signed subject so the follow-up mint can prove
      // the auth tip before the indexer has the deploy.
      const wrap = new Beef()
      wrap.mergeBeef(signable.tx)
      wrap.mergeTransaction(unsigned)
      wrap.atomicTxid = undefined
      txBinary = asTrustSelfInputBeef(wrap)
    } catch (err) {
      console.warn('[bsv21-issuer] could not wrap signed mint tx for BEEF cache', err)
    }
  }
  if (txBinary?.length) {
    try {
      const stored = asTrustSelfInputBeef(Beef.fromBinary(txBinary)) ?? txBinary
      rememberBeefBinary(txid, stored)
      txBinary = stored
    } catch {
      rememberBeefBinary(txid, txBinary)
    }
  }

  return {
    txid,
    ...(txBinary ? { tx: txBinary } : {}),
  }
}

/**
 * If identity-mint createAction returned a signable (auth tip unlock pending),
 * finish it so the app gets a txid like a normal createAction.
 */
export async function finishBsv21IdentityMintCreateAction(
  active: ActiveWallet,
  args: unknown,
  result: unknown,
): Promise<unknown> {
  if (!isBsv21IdentityMintArgs('createAction', args)) return result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const row = result as {
    txid?: unknown
    signableTransaction?: Bsv21SignableTransaction
  }
  if (typeof row.txid === 'string' && row.txid.trim()) return result
  const signable = row.signableTransaction
  if (!signable?.reference || !Array.isArray(signable.tx)) return result

  const inputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? ((args as CreateActionArgs).inputs ?? [])
      : []
  const outpoints = inputs.map((i) => i.outpoint).filter(Boolean)
  if (outpoints.length === 0) return result

  const completed = await completeBsv21SignableWithRootP2pkh(
    active,
    signable,
    outpoints,
  )
  const { signableTransaction: _drop, ...rest } = row
  return {
    ...rest,
    txid: completed.txid,
    ...(completed.tx ? { tx: completed.tx } : {}),
  }
}

function symFromOutput(out: CreateActionOutput): string | null {
  for (const tag of out.tags ?? []) {
    if (tag.toLowerCase().startsWith('sym:')) return tag.slice(4).trim() || null
  }
  if (out.customInstructions) {
    try {
      const ci = JSON.parse(out.customInstructions) as { sym?: unknown }
      if (typeof ci.sym === 'string' && ci.sym.trim()) return ci.sym.trim()
    } catch {
      // ignore
    }
  }
  return null
}
