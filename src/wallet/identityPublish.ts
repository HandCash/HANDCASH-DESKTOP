import type { PrivateKey } from '@bsv/sdk'
import {
  BAP_BASKET,
  BAP_KEY_ID,
  BAP_PROTOCOL_ID,
  IMPORTED_BAP_BASKET,
  bapAddress,
  bapAliasScript,
  bapIdFor,
  bapIdScript,
  bapKey,
  bFileScript,
} from './bapRecords'
import {
  bapKeyChain,
  buildIssuerIdentityPackage,
  currentIssuerSigningKey,
  issuerIdentityFields,
  issuerIdentityImage,
  issuerIdentityPackageBeef,
  issuerIdentityPackageRoots,
  issuerProfile,
  type IssuerIdentity,
  type IssuerIdentityFields,
  type IssuerIdentityImage,
} from './issuerIdentity'
import { issuerIdentityPackage } from './issuerIdentities'
import { normalizeIssuerIdentityKey } from './issuerMetadata'
import {
  identityMasterKey,
  listPublicIdentities,
  publishedIdentityForIssuer,
  recordPublishedIdentity,
} from './publicIdentities'
import type { ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

/**
 * Publish and maintain BAP issuer identities. Every record is a 0-sat,
 * AIP-signed data output, sent through the signed-send lifecycle like any
 * other signed transaction; none of them holds value. The wallet's own key
 * tree sits in basket `bap` exactly as 1Sat wallets keep it, so a 1Sat app on
 * this wallet sees the same identity; an imported master's sits in `bap issuer`.
 */

type DataOutput = {
  lockingScript: string
  satoshis: 0
  outputDescription: string
  basket: string
  tags: string[]
  customInstructions?: string
}

type Signer = { master: PrivateKey; own: boolean; basket: string }

const PROOF_FETCH_MS = 8_000

function assertCurrent(runtime: WalletRuntime): ActiveWallet {
  if (!runtimeIsCurrent(runtime)) throw new Error('Wallet changed; publish again.')
  return runtime.instance
}

function signerFor(runtime: WalletRuntime, identityKey: string): Signer {
  const { master, own } = identityMasterKey(runtime, identityKey)
  return { master, own, basket: own ? BAP_BASKET : IMPORTED_BAP_BASKET }
}

function logSlow(phase: string, started: number) {
  const ms = Date.now() - started
  if (ms > 250) console.info(`[identity-publish] ${phase} done ${ms}ms`)
}

async function sendIdentityRecords(
  active: ActiveWallet,
  description: string,
  outputs: DataOutput[],
): Promise<{ txid: string; tx: number[] }> {
  const created = await active.wallet.createAction({
    description,
    labels: ['bap-identity'],
    outputs,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: true },
  })
  const txid = typeof created.txid === 'string' ? created.txid.toLowerCase() : ''
  const tx = created.tx ? Array.from(created.tx) : []
  if (!/^[0-9a-f]{64}$/.test(txid) || !tx.length) throw new Error(`${description} was not signed.`)
  const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
  const handle = await registerSignedSend({ txid, atomicBeef: tx, flow: 'identity_publish', satoshis: 0 })
  startSignedSendPropagation(handle)
  return { txid, tx }
}

/**
 * BAP records for `bapId` this wallet holds: its own publishes, records the
 * earlier ID-panel compose wrote, and records another BRC-100 app wrote into
 * `bap`. Null when it holds none.
 */
async function heldBapRecords(active: ActiveWallet, basket: string, bapId: string): Promise<number[] | null> {
  try {
    const held = await active.wallet.listOutputs({
      basket,
      tags: [`bapId:${bapId}`],
      include: 'entire transactions',
      limit: 100,
    })
    return held.outputs.length && held.BEEF?.length ? Array.from(held.BEEF) : null
  } catch (error) {
    console.warn('[identity-publish] held BAP records unreadable', error)
    return null
  }
}

/** Every record this wallet knows for `bapId`: its stored package and what it holds. */
async function knownRecords(active: ActiveWallet, basket: string, bapId: string): Promise<number[][]> {
  const pkg = issuerIdentityPackage(active.chain, bapId)
  const held = await heldBapRecords(active, basket, bapId)
  return [...(pkg ? [issuerIdentityPackageBeef(pkg)] : []), ...(held ? [held] : [])]
}

const idOutput = (signer: Signer, bapId: string, seq: number, lockingScript: string): DataOutput => ({
  lockingScript,
  satoshis: 0,
  outputDescription: 'BAP ID',
  basket: signer.basket,
  tags: ['type:id', `bapId:${bapId}`, `seq:${seq}`],
  ...(signer.own
    ? { customInstructions: JSON.stringify({ protocolID: BAP_PROTOCOL_ID, keyID: `${BAP_KEY_ID}-${seq}` }) }
    : {}),
})

const aliasOutput = (signer: Signer, bapId: string, lockingScript: string): DataOutput => ({
  lockingScript,
  satoshis: 0,
  outputDescription: 'BAP ALIAS',
  basket: signer.basket,
  tags: ['type:alias', `bapId:${bapId}`, `publishedAt:${Date.now()}`],
})

const sameImage = (a: IssuerIdentityImage, b: IssuerIdentityImage) =>
  a.contentType === b.contentType &&
  a.bytes.length === b.bytes.length &&
  a.bytes.every((byte, i) => byte === b.bytes[i])

function packaged(
  runtime: WalletRuntime,
  identityKey: string,
  bapId: string,
  beefs: number[][],
  aliasTxid: string,
): IssuerIdentity {
  const pkg = buildIssuerIdentityPackage(bapId, beefs, { preferAlias: aliasTxid })
  if (!pkg)
    throw new Error(`Identity ${aliasTxid.slice(0, 12)} is broadcasting, but its proof could not be packaged.`)
  return recordPublishedIdentity(runtime, identityKey, pkg)
}

/**
 * Publish or update an identity's profile. Without a key chain, the root
 * declares `identity-1` beside the ALIAS; with one (stored, or held from an
 * earlier publish or another app), only a new ALIAS signed by the current key
 * is written. A new image is its own B:// file transaction; an unchanged image
 * is referenced again, never re-uploaded.
 */
export async function publishIssuerIdentity(
  runtime: WalletRuntime,
  identityKey: string,
  fields: IssuerIdentityFields,
  image: IssuerIdentityImage | null,
): Promise<IssuerIdentity> {
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!key) throw new Error('Invalid issuer identity key.')
  const clean = issuerIdentityFields(fields)
  const bitmap = image ? issuerIdentityImage(image) : null
  const started = Date.now()
  return runExclusiveSpend(async () => {
    const active = assertCurrent(runtime)
    const signer = signerFor(runtime, key)
    const { master } = signer
    const bapId = bapIdFor(master)
    const prior = publishedIdentityForIssuer(runtime, key)
    const beefs = await knownRecords(active, signer.basket, bapId)
    assertCurrent(runtime)
    const chain = bapKeyChain(bapId, beefs)
    if (chain?.revoked) throw new Error('This identity was revoked and cannot be updated.')
    const signingKey = chain ? currentIssuerSigningKey(master, chain) : bapKey(master, 1)
    let imageTxid = prior?.imageTxid
    if (bitmap && !(imageTxid && prior?.image && sameImage(prior.image, bitmap))) {
      const file = await sendIdentityRecords(active, 'Issuer identity image', [
        {
          lockingScript: bFileScript(bitmap),
          satoshis: 0,
          outputDescription: 'Identity image',
          basket: signer.basket,
          tags: ['type:image', `bapId:${bapId}`],
        },
      ])
      imageTxid = file.txid
      beefs.push(file.tx)
      assertCurrent(runtime)
    }
    if (!imageTxid) throw new Error('Choose an image first.')
    const outputs: DataOutput[] = []
    if (!chain)
      outputs.push(
        idOutput(signer, bapId, 1, bapIdScript({ bapId, address: bapAddress(master, 1), signer: bapKey(master, 0) })),
      )
    outputs.push(
      aliasOutput(signer, bapId, bapAliasScript({ bapId, profile: issuerProfile(clean, imageTxid), signer: signingKey })),
    )
    const alias = await sendIdentityRecords(active, chain ? 'Update issuer identity' : 'Publish issuer identity', outputs)
    beefs.push(alias.tx)
    const identity = packaged(runtime, key, bapId, beefs, alias.txid)
    logSlow('publish', started)
    return identity
  })
}

/**
 * Retire the current signing key: the outgoing key declares `identity-N+1`,
 * which re-signs the same profile in the same transaction. Assets the old key
 * signed stay attributed when mined before this rotation is.
 */
export async function rotateIssuerSigningKey(runtime: WalletRuntime, identityKey: string): Promise<IssuerIdentity> {
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!key) throw new Error('Invalid issuer identity key.')
  const started = Date.now()
  return runExclusiveSpend(async () => {
    const active = assertCurrent(runtime)
    const signer = signerFor(runtime, key)
    const prior = publishedIdentityForIssuer(runtime, key)
    if (!prior) throw new Error('Publish the identity before rotating its key.')
    if (!prior.imageTxid) throw new Error('Publish an image before rotating the key.')
    const beefs = await knownRecords(active, signer.basket, prior.bapId)
    assertCurrent(runtime)
    const chain = bapKeyChain(prior.bapId, beefs)
    if (!chain) throw new Error('The identity package is missing; restore an identity backup.')
    if (chain.revoked) throw new Error('This identity was revoked.')
    const outgoing = currentIssuerSigningKey(signer.master, chain)
    const seq = chain.keys.at(-1)!.seq + 1
    const next = bapKey(signer.master, seq)
    const profile = issuerProfile({ name: prior.name, description: prior.description }, prior.imageTxid)
    const rotation = await sendIdentityRecords(active, 'Rotate issuer signing key', [
      idOutput(signer, prior.bapId, seq, bapIdScript({ bapId: prior.bapId, address: next.toAddress(), signer: outgoing })),
      aliasOutput(signer, prior.bapId, bapAliasScript({ bapId: prior.bapId, profile, signer: next })),
    ])
    const identity = packaged(runtime, key, prior.bapId, [...beefs, rotation.tx], rotation.txid)
    logSlow('rotate', started)
    return identity
  })
}

/**
 * Bring this wallet's identity packages in line with the BAP records it holds:
 * adopt a chain the earlier BAP compose published, and follow a rotation or
 * revocation another BRC-100 app wrote into `bap`, so issuance never signs with
 * a retired key. A profile change alone is left to this wallet's own publish,
 * whose ALIAS choice it would otherwise override.
 */
export async function syncHeldIssuerIdentities(runtime: WalletRuntime | null, onlyKey?: string): Promise<number> {
  if (!runtime || !runtimeIsCurrent(runtime)) return 0
  const active = runtime.instance
  let synced = 0
  for (const row of listPublicIdentities(runtime)) {
    if (onlyKey && row.identityKey !== onlyKey) continue
    const basket = row.signer === 'wallet' ? BAP_BASKET : IMPORTED_BAP_BASKET
    const held = await heldBapRecords(active, basket, row.bapId)
    if (!held || !runtimeIsCurrent(runtime)) continue
    const stored = row.identity ? issuerIdentityPackage(active.chain, row.bapId) : null
    const beefs = stored ? [issuerIdentityPackageBeef(stored), held] : [held]
    if (row.identity) {
      const chain = bapKeyChain(row.bapId, beefs)
      if (!chain || (chain.keys.length === row.identity.keys.length && !!chain.revoked === !!row.identity.revoked))
        continue
    }
    const pkg = buildIssuerIdentityPackage(row.bapId, beefs)
    if (!pkg) {
      if (row.identity) console.warn('[identity-publish] key chain moved; publish an update to re-sign the profile')
      continue
    }
    try {
      recordPublishedIdentity(runtime, row.identityKey, pkg)
      synced++
    } catch (error) {
      console.warn('[identity-publish] held identity not synced', error)
    }
  }
  return synced
}

/**
 * Swap unmined records in this wallet's own packages for mined copies, once
 * their proofs exist and match block headers. Heights are what order a key
 * rotation for every holder, so packages should carry them as soon as they can.
 */
export async function upgradeIssuerIdentityProofs(runtime: WalletRuntime): Promise<number> {
  if (!runtimeIsCurrent(runtime)) return 0
  const active = runtime.instance
  const tracker = await Promise.resolve(active.services?.getChainTracker?.()).catch(() => null)
  if (!tracker) return 0
  const { getBeefForTxidCached } = await import('./beefCache')
  let upgraded = 0
  for (const row of listPublicIdentities(runtime)) {
    const identity = row.identity
    const pkg = identity ? issuerIdentityPackage(active.chain, identity.bapId) : null
    if (!identity || !pkg) continue
    const unmined = new Set([
      ...identity.keys.filter((k) => k.minedHeight === undefined).map((k) => k.txid),
      ...(identity.alias.minedHeight === undefined ? [identity.alias.txid] : []),
      ...(identity.revoked && identity.revoked.minedHeight === undefined ? [identity.revoked.txid] : []),
    ])
    if (!unmined.size) continue
    const proven: number[][] = []
    for (const txid of unmined) {
      try {
        const beef = await Promise.race([
          getBeefForTxidCached(active, txid, { needProof: true }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PROOF_FETCH_MS)),
        ])
        if (beef.findTxid(txid)?.bumpIndex !== undefined) proven.push(beef.toBinary())
      } catch {
        /* not mined yet, or no proof source answered */
      }
    }
    if (!proven.length || !runtimeIsCurrent(runtime)) continue
    const next = buildIssuerIdentityPackage(identity.bapId, [issuerIdentityPackageBeef(pkg), ...proven], {
      preferAlias: identity.alias.txid,
    })
    const roots = next && next.beefB64 !== pkg.beefB64 ? issuerIdentityPackageRoots(next) : null
    if (!next || !roots) continue
    try {
      let confirmed = true
      for (const { root, height } of roots)
        if (!(await tracker.isValidRootForHeight(root, height))) confirmed = false
      if (!confirmed) continue
      recordPublishedIdentity(runtime, row.identityKey, next)
      upgraded++
    } catch (error) {
      console.warn('[identity-publish] proof upgrade skipped', error)
    }
  }
  return upgraded
}
