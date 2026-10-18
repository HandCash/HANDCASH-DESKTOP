import { Transaction } from '@bsv/sdk'
import { inputScriptValid, sourceOutputOf, sourceTxidOf } from '../countersign/script'
import { backingCount, backingDepositKey, backingDepositOf, checkBackingProof, type BackingOutpoint, type HctBackingProof } from './backing'
import { hctIssuerKeyOf } from './keys'
import { decodeHctPayload, hctSupplyPolicy, type HctDeployFields } from './payload'
import {
  HCT_ISSUER_SCOPE,
  hctAssetId,
  hctBeaconLock,
  hctUnlockBranch,
  multisigLock,
  p2pkLock,
  readHct,
  rulesOf,
  sameRules,
  type HctIssued,
  type HctOutput,
  type HctRules,
} from './script'

/**
 * BRC-255 validity, offline from Extended Format transactions. Code decides
 * every fact here; nothing trusts an indexer, an overlay or the sender.
 */

export type HctDeploy = {
  assetId: string
  txid: string
  vout: number
  supply: bigint
  rules: HctRules
  fields: HctDeployFields
  /** The clause keys derived from `iss` (§3), in order. */
  issuerKeys: string[]
  /** An item whose deploy spent its collection's authority (§5). */
  member: boolean
}

export type DeployRefusal =
  | 'not-deploy'
  | 'payload'
  | 'clause'
  | 'item-supply'
  | 'over-cap'
  | 'unsigned'
  | 'beacon'
  | 'backing'

export type DeployRead = { ok: true; deploy: HctDeploy } | { ok: false; reason: DeployRefusal; detail: string }

function expectedRules(fields: HctDeployFields, issuerKeys: string[]): HctRules {
  if (fields.mode === 'open') return { mode: 'open' }
  return {
    mode: 'countersign',
    issuer: { m: fields.m, keys: issuerKeys },
    release: fields.rel ? { kind: 'hash', rel: fields.rel } : { kind: 'keys', k: fields.k!, keys: fields.relk! },
  }
}

/** Every signature an issuer-coin unlock carries is ALL|FORKID. */
function signedAllForkId(tx: Transaction, vin: number, signatures: number): boolean {
  const chunks = tx.inputs[vin]?.unlockingScript?.chunks ?? []
  const sigs = signatures === 1 ? chunks : chunks.slice(1)
  if (signatures > 1 && (chunks[0]?.op !== 0 || chunks[0]?.data?.length)) return false
  if (sigs.length !== signatures) return false
  return sigs.every((c) => !!c.data?.length && c.data[c.data.length - 1] === HCT_ISSUER_SCOPE)
}

/** True when some input spends a coin locked to the issuer keys, signed ALL|FORKID (§3). */
export function deploySignedByIssuer(tx: Transaction, issuerKeys: string[], m: number): boolean {
  const lock = (issuerKeys.length === 1 ? p2pkLock(issuerKeys[0]!) : multisigLock(m, issuerKeys)).toHex()
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const source = sourceOutputOf(tx, vin)
    if (!source || source.lockingScript.toHex() !== lock) continue
    if (signedAllForkId(tx, vin, issuerKeys.length === 1 ? 1 : m) && inputScriptValid(tx, vin)) return true
  }
  return false
}

/** Did input `vin` spend an authority of `collection`, validly? */
function spendsCollectionAuthority(tx: Transaction, vin: number, collection: string): boolean {
  const source = sourceOutputOf(tx, vin)
  const read = source ? readHct(source.lockingScript) : null
  if (!read) return false
  const isAuthority =
    (read.form === 'authority' && read.assetId === collection) ||
    (read.form === 'deploy' &&
      hctAssetId(sourceTxidOf(tx, vin), tx.inputs[vin]!.sourceOutputIndex) === collection &&
      decodeHctPayload(read.payload)?.auth === true)
  return isAuthority && inputScriptValid(tx, vin)
}

/**
 * Read deploy output `vout` of an Extended Format transaction: payload,
 * clause matching the mode and the issuer keys derived from `iss`, an item
 * of supply one, the issuer's signature on an input, and in countersigned
 * mode the beacon when this transaction writes it.
 */
export function readHctDeploy(tx: Transaction, vout: number): DeployRead {
  const script = tx.outputs[vout]?.lockingScript
  const read = script ? readHct(script) : null
  if (!read || read.form !== 'deploy') return { ok: false, reason: 'not-deploy', detail: `output ${vout} is not an HCT deploy` }
  const fields = decodeHctPayload(read.payload)
  if (!fields) return { ok: false, reason: 'payload', detail: 'the payload is not a BRC-255 payload' }
  let issuerKeys: string[]
  try {
    issuerKeys = fields.iss.map(hctIssuerKeyOf)
  } catch {
    return { ok: false, reason: 'payload', detail: 'iss names an invalid key' }
  }
  const rules = expectedRules(fields, issuerKeys)
  if (!sameRules(rulesOf(read.clause), rules)) {
    return { ok: false, reason: 'clause', detail: 'the clause does not match the payload mode and issuer keys' }
  }
  if (fields.kind === 'item' && read.supply !== 1n) return { ok: false, reason: 'item-supply', detail: 'an item has a supply of one' }
  if (fields.max != null && read.supply > fields.max) {
    return { ok: false, reason: 'over-cap', detail: `the supply ${read.supply} is over the cap of ${fields.max}` }
  }
  if (!deploySignedByIssuer(tx, issuerKeys, fields.m)) {
    return { ok: false, reason: 'unsigned', detail: 'no input is signed ALL|FORKID by the issuer keys' }
  }
  const txid = String(tx.id('hex')).toLowerCase()
  if (rules.mode === 'countersign' && fields.bcn?.startsWith(`${txid}_`)) {
    const beacon = tx.outputs[Number(fields.bcn.slice(65))]?.lockingScript
    if (!beacon || beacon.toHex() !== hctBeaconLock(rules).toHex()) {
      return { ok: false, reason: 'beacon', detail: 'bcn names an output of this deploy that is not its beacon' }
    }
  }
  if (fields.bk && backingCount(tx, txid, hctAssetId(txid, vout), txid) !== 1) {
    return { ok: false, reason: 'backing', detail: 'a backed deploy names exactly one deposit' }
  }
  const member = fields.col ? tx.inputs.some((_, vin) => spendsCollectionAuthority(tx, vin, fields.col!)) : false
  return {
    ok: true,
    deploy: { assetId: hctAssetId(txid, vout), txid, vout, supply: read.supply, rules, fields, issuerKeys, member },
  }
}

/** Every deploy output of a transaction that reads as an asset. */
export function readHctDeploys(tx: Transaction): HctDeploy[] {
  const out: HctDeploy[] = []
  for (let vout = 0; vout < Math.min(tx.outputs.length, 256); vout++) {
    const read = readHctDeploy(tx, vout)
    if (read.ok) out.push(read.deploy)
  }
  return out
}

export type TxRefusal = 'input' | 'output' | 'conservation' | 'mint' | 'over-cap' | 'item' | 'conjured' | 'unrelated' | 'backing'
export type TxCheck =
  | {
      ok: true
      inputs: number[]
      accepted: boolean
      outputs: Array<{ vout: number; amount: bigint; authority: boolean }>
      issued?: HctIssued
      /** Units this transaction issues: written minus spent when it spends an authority, else 0. */
      minted: bigint
    }
  | { ok: false; reason: TxRefusal; detail: string }

type AssetInput = { vin: number; amount: bigint; authority: boolean; issued?: HctIssued }

/** What a capped asset's deploy has issued when its authority is first spent; null for any other asset. */
export function deployIssued(deploy: Pick<HctDeploy, 'supply' | 'fields'>): HctIssued | null {
  return hctSupplyPolicy(deploy.fields).kind === 'capped' ? { units: deploy.supply, members: 0n } : null
}

/** Deploy outputs of `tx` that name `collection`: each counts against the collection's size. */
function membersWritten(tx: Transaction, collection: string): bigint {
  let n = 0n
  for (const output of tx.outputs) {
    const read = output.lockingScript ? readHct(output.lockingScript) : null
    if (read?.form === 'deploy' && decodeHctPayload(read.payload)?.col === collection) n += 1n
  }
  return n
}

function assetInput(tx: Transaction, vin: number, deploy: HctDeploy): (AssetInput & { read: HctOutput }) | null {
  const source = sourceOutputOf(tx, vin)
  const read = source ? readHct(source.lockingScript) : null
  if (!read) return null
  if (read.form === 'deploy') {
    const txid = sourceTxidOf(tx, vin)
    if (txid !== deploy.txid || tx.inputs[vin]!.sourceOutputIndex !== deploy.vout) return null
    const issued = deployIssued(deploy)
    return { vin, amount: deploy.supply, authority: deploy.fields.auth === true, ...(issued ? { issued } : {}), read }
  }
  if (read.assetId !== deploy.assetId) return null
  if (read.form === 'held') return { vin, amount: read.amount, authority: false, read }
  return { vin, amount: 0n, authority: true, ...(read.issued ? { issued: read.issued } : {}), read }
}

/**
 * §4 for one asset in one transaction, from its claimed spent scripts:
 * closure, conservation, minting, items, no conjuring, and a script check of
 * every input that spends the asset. `accepted` is true when the asset is
 * countersigned and every one of those inputs took the issuer branch.
 */
export function checkHctTx(tx: Transaction, deploy: HctDeploy): TxCheck {
  const inputs: AssetInput[] = []
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    if (!sourceOutputOf(tx, vin)) return { ok: false, reason: 'input', detail: `input ${vin} carries no source output` }
    const hit = assetInput(tx, vin, deploy)
    if (!hit) continue
    if (!sameRules(rulesOf(hit.read.clause), deploy.rules)) {
      return { ok: false, reason: 'input', detail: `input ${vin} spends ${deploy.assetId} under another clause` }
    }
    if (!inputScriptValid(tx, vin)) return { ok: false, reason: 'input', detail: `input ${vin} does not unlock its source` }
    inputs.push(hit)
  }
  const capped = hctSupplyPolicy(deploy.fields).kind === 'capped'
  const outputs: Array<{ vout: number; amount: bigint; authority: boolean; issued?: HctIssued }> = []
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const script = tx.outputs[vout]!.lockingScript
    const hex = script?.toHex() ?? ''
    const marked = hex.startsWith(`17686374${deploy.assetId}`)
    const read = script ? readHct(script) : null
    if (read?.form === 'deploy' || !marked) continue
    if (!read) return { ok: false, reason: 'output', detail: `output ${vout} names ${deploy.assetId} but is not canonical` }
    if (!sameRules(rulesOf(read.clause), deploy.rules)) {
      return { ok: false, reason: 'output', detail: `output ${vout} writes ${deploy.assetId} under another clause` }
    }
    if ((tx.outputs[vout]!.satoshis ?? 0) < 1) return { ok: false, reason: 'output', detail: `output ${vout} carries no satoshi` }
    if (read.form === 'authority' && capped !== (read.issued != null)) {
      return { ok: false, reason: 'output', detail: `output ${vout} ${capped ? 'omits' : 'writes'} the issued count of ${deploy.assetId}` }
    }
    outputs.push({
      vout,
      amount: read.form === 'held' ? read.amount : 0n,
      authority: read.form === 'authority',
      ...(read.form === 'authority' && read.issued ? { issued: read.issued } : {}),
    })
  }
  if (inputs.length === 0 && outputs.length === 0) {
    return { ok: false, reason: 'unrelated', detail: `the transaction neither spends nor writes ${deploy.assetId}` }
  }
  if (inputs.length === 0) return { ok: false, reason: 'conjured', detail: `${deploy.assetId} is written without being spent` }
  const ins = inputs.reduce((sum, i) => sum + i.amount, 0n)
  const outs = outputs.reduce((sum, o) => sum + o.amount, 0n)
  const mints = inputs.some((i) => i.authority)
  const authorities = outputs.filter((o) => o.authority).length
  if (authorities > 0 && !mints) return { ok: false, reason: 'mint', detail: 'an authority is written without spending one' }
  if (authorities > 1) return { ok: false, reason: 'mint', detail: 'more than one authority is written' }
  if (inputs.filter((i) => i.authority).length > 1) return { ok: false, reason: 'mint', detail: 'more than one authority is spent' }
  if (mints ? outs < ins : outs !== ins) {
    return { ok: false, reason: 'conservation', detail: `${deploy.assetId} writes ${outs} from ${ins}` }
  }
  let issued: HctIssued | undefined
  if (capped && mints) {
    const before = inputs.find((i) => i.authority)!.issued
    if (!before) return { ok: false, reason: 'input', detail: `the authority of ${deploy.assetId} carries no issued count` }
    issued = { units: before.units + (outs - ins), members: before.members + membersWritten(tx, deploy.assetId) }
    const { max, size } = deploy.fields
    if (max != null && issued.units > max) {
      return { ok: false, reason: 'over-cap', detail: `${deploy.assetId} would have ${issued.units} units, over its cap of ${max}` }
    }
    if (size != null && issued.members > size) {
      return { ok: false, reason: 'over-cap', detail: `${deploy.assetId} would have ${issued.members} members, over its size of ${size}` }
    }
    const written = outputs.find((o) => o.authority)?.issued
    if (written && (written.units !== issued.units || written.members !== issued.members)) {
      return {
        ok: false,
        reason: 'mint',
        detail: `the authority states ${written.units} units and ${written.members} members issued; it is ${issued.units} and ${issued.members}`,
      }
    }
  }
  if (deploy.fields.kind === 'item' && outs !== 1n) {
    return { ok: false, reason: 'item', detail: `item ${deploy.assetId} is written ${outs} times` }
  }
  const minted = mints ? outs - ins : 0n
  if (deploy.fields.bk) {
    const txid = String(tx.id('hex')).toLowerCase()
    const named = backingCount(tx, txid, deploy.assetId, deploy.txid)
    if (minted > 0n && named !== 1) return { ok: false, reason: 'backing', detail: `a mint of ${deploy.assetId} names exactly one deposit` }
    if (minted === 0n && named !== 0) return { ok: false, reason: 'backing', detail: `only a mint of ${deploy.assetId} names a deposit` }
  }
  const accepted =
    deploy.rules.mode === 'countersign' && inputs.every((i) => hctUnlockBranch(tx.inputs[i.vin]!.unlockingScript) === 'issuer')
  return { ok: true, inputs: inputs.map((i) => i.vin), accepted, outputs, ...(issued ? { issued } : {}), minted }
}

export type WalkResult =
  | { ok: true; validated: string[]; backed: Array<{ txid: string; proof: HctBackingProof; deposit: string }> }
  | { ok: false; reason: 'missing'; txid: string; detail: string }
  | { ok: false; reason: 'invalid'; txid: string; detail: string }

/** Most transactions one walk reads before it stops as `missing`. */
export const MAX_HCT_WALK = 20_000

type Claim = { child: string; vout: number; scriptHex: string; satoshis: number }

type BackingNeed = { kind: 'none' } | { kind: 'needed'; deposit: BackingOutpoint; minted: bigint } | { kind: 'invalid'; detail: string }

/**
 * Does spending `claims` of `tx` need its deposit's burial proof? Only when
 * `tx` is a backed deploy or mint and a claim takes units it wrote; its
 * authority alone moves freely, so minting never waits on an earlier proof.
 */
export function hctBackingNeed(tx: Transaction, txid: string, deploy: HctDeploy, claimedVouts: readonly number[]): BackingNeed {
  if (!deploy.fields.bk) return { kind: 'none' }
  const takesUnits = claimedVouts.some((vout) => {
    const script = tx.outputs[vout]?.lockingScript
    const read = script ? readHct(script) : null
    return read?.form === 'deploy' || (read?.form === 'held' && read.amount > 0n)
  })
  if (!takesUnits) return { kind: 'none' }
  const deposit = backingDepositOf(tx, txid, deploy.assetId, deploy.txid)
  if (!deposit) return { kind: 'none' }
  if (txid === deploy.txid) return { kind: 'needed', deposit, minted: deploy.supply }
  const check = checkHctTx(tx, deploy)
  if (!check.ok) return { kind: 'invalid', detail: `${check.reason}: ${check.detail}` }
  return { kind: 'needed', deposit, minted: check.minted }
}

/**
 * Where a walk finds burial proofs: ones this device already checked, and
 * unchecked ones a package or history supplied. `issuanceOf` names the
 * transaction a deposit (`backingDepositKey`) already backs on this device.
 */
export type BackingSource = {
  proven: (txid: string) => boolean
  proofOf: (txid: string) => Promise<HctBackingProof | null>
  issuanceOf?: (deposit: string) => Promise<string | null>
}

const NO_BACKING: BackingSource = { proven: () => false, proofOf: async () => null }

/**
 * §7: validate the outputs of `subject` for one asset. Each transaction is
 * checked against §4; the walk stops at the deploy, at a transaction already
 * validated, or (countersigned) at an accepted transaction, and otherwise
 * continues into the transaction behind every input that spends the asset.
 * Release-branch inputs are never accepted, so they always walk back.
 *
 * Extended Format only claims what an input spends, and a signature covers
 * the claim, so every claim is compared with the parent's real output
 * whenever the walk reaches that parent: an unmined child cannot claim more
 * than its parent wrote. `txOf` returns an Extended Format transaction
 * (sources linked) or null.
 */
export async function walkHct(
  subjectTxid: string,
  deploy: HctDeploy,
  txOf: (txid: string) => Promise<Transaction | null>,
  isValidated: (txid: string) => boolean,
  backing: BackingSource = NO_BACKING,
): Promise<WalkResult> {
  const subject = subjectTxid.toLowerCase()
  const queue: Array<{ txid: string; claims: Claim[] }> = [{ txid: subject, claims: [] }]
  const loaded = new Map<string, Transaction>()
  const checked = new Set<string>()
  const validated: string[] = []
  const backed: Array<{ txid: string; proof: HctBackingProof; deposit: string }> = []
  const buried = new Set<string>()
  const depositsBacking = new Map<string, string>()
  const load = async (txid: string): Promise<Transaction | null> => {
    const known = loaded.get(txid)
    if (known) return known
    if (loaded.size >= MAX_HCT_WALK) return null
    const tx = await txOf(txid)
    if (tx) loaded.set(txid, tx)
    return tx
  }
  while (queue.length > 0) {
    const { txid, claims } = queue.shift()!
    const tx = await load(txid)
    if (!tx) {
      const detail = loaded.size >= MAX_HCT_WALK ? `history is over ${MAX_HCT_WALK} transactions` : `transaction ${txid} is not available`
      return { ok: false, reason: 'missing', txid, detail }
    }
    if (String(tx.id('hex')).toLowerCase() !== txid) return { ok: false, reason: 'invalid', txid, detail: 'a supplied transaction has another txid' }
    for (const claim of claims) {
      const real = tx.outputs[claim.vout]
      if (!real?.lockingScript || real.lockingScript.toHex() !== claim.scriptHex || real.satoshis !== claim.satoshis) {
        return { ok: false, reason: 'invalid', txid: claim.child, detail: `it claims output ${claim.vout} of ${txid} as something that transaction did not write` }
      }
    }
    if (deploy.fields.bk && claims.length > 0 && !buried.has(txid) && !backing.proven(txid)) {
      const need = hctBackingNeed(tx, txid, deploy, claims.map((c) => c.vout))
      if (need.kind === 'invalid') return { ok: false, reason: 'invalid', txid, detail: need.detail }
      if (need.kind === 'needed') {
        const deposit = backingDepositKey(deploy.fields.bk, need.deposit)
        const prior = depositsBacking.get(deposit) ?? (await backing.issuanceOf?.(deposit)) ?? null
        if (prior && prior !== txid) {
          return { ok: false, reason: 'invalid', txid, detail: `its deposit ${need.deposit.txid}:${need.deposit.vout} already backs ${prior}` }
        }
        const proof = await backing.proofOf(txid)
        if (!proof) return { ok: false, reason: 'missing', txid, detail: `the burial proof of the deposit behind ${txid} is not available` }
        const check = await checkBackingProof(deploy.fields.bk, proof, need.deposit, need.minted)
        if (!check.ok && check.missing) return { ok: false, reason: 'missing', txid, detail: `the burial proof of the deposit behind ${txid} does not check yet (${check.detail})` }
        if (!check.ok) return { ok: false, reason: 'invalid', txid: claims[0]!.child, detail: `it moves units of ${txid} without a valid burial proof (${check.detail})` }
        backed.push({ txid, proof, deposit })
        buried.add(txid)
        depositsBacking.set(deposit, txid)
      }
    }
    if (checked.has(txid)) continue
    checked.add(txid)
    if (txid === deploy.txid) {
      const read = readHctDeploy(tx, deploy.vout)
      if (!read.ok || read.deploy.assetId !== deploy.assetId) return { ok: false, reason: 'invalid', txid, detail: 'the deploy does not read back' }
      continue
    }
    if (txid !== subject && isValidated(txid)) continue
    const check = checkHctTx(tx, deploy)
    if (!check.ok) return { ok: false, reason: 'invalid', txid, detail: `${check.reason}: ${check.detail}` }
    validated.push(txid)
    if (check.accepted) continue
    const byParent = new Map<string, Claim[]>()
    for (const vin of check.inputs) {
      const parent = sourceTxidOf(tx, vin)
      const source = sourceOutputOf(tx, vin)!
      const list = byParent.get(parent) ?? []
      list.push({ child: txid, vout: tx.inputs[vin]!.sourceOutputIndex, scriptHex: source.lockingScript.toHex(), satoshis: source.satoshis })
      byParent.set(parent, list)
    }
    for (const [parent, parentClaims] of byParent) queue.push({ txid: parent, claims: parentClaims })
  }
  return { ok: true, validated, backed }
}
