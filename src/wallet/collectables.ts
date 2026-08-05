/**
 * Collectables = outputs in BRC-100 basket `1sat`.
 * Recursive inscription content (HTML/JS that loads other inscriptions) is still a 1sat tip —
 * same basket, same customInstructions remittance, same BRC-39 historyReplica. No second basket.
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  contentUrlForOrigin,
  resolveOneSatInscription,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
import { resolvePaymentAddress } from './friends'
import { assertOnlineForPayment } from './paymentPolicy'
import { prepareSpendHeal, runExclusiveSpend } from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  buildCollectableCustomInstructions,
  tryBuildProvenanceForSend,
  verifyProvenance,
} from './oneSatProvenance'
import type { Chain } from './vault'

export type { CollectableTrait }

export type Collectable = {
  /** Wallet outpoint `txid.vout` */
  outpoint: string
  /** Inscription origin `txid_vout` */
  origin: string
  name: string
  app?: string
  imageUrl: string
  satoshis: number
  mimeType?: string
  type?: string
  subType?: string
  collectionId?: string
  traits: CollectableTrait[]
  extras: CollectableTrait[]
  /** BRC-150 provenance verified for this tip (false = claim / indexer only). */
  proven: boolean
}

type CollectablesListener = (items: Collectable[]) => void

let cachedCollectables: Collectable[] = []
/** True after at least one successful list (even if empty). */
let collectablesHydrated = false
const collectablesListeners = new Set<CollectablesListener>()

function notifyCollectables(items: Collectable[]) {
  for (const listener of collectablesListeners) listener(items)
}

function setCollectablesCache(items: Collectable[]) {
  cachedCollectables = items
  collectablesHydrated = true
  notifyCollectables(items)
}

export function clearCollectablesCache(): void {
  cachedCollectables = []
  collectablesHydrated = false
  notifyCollectables([])
}

export function getCachedCollectables(): Collectable[] {
  return cachedCollectables.slice()
}

export function areCollectablesHydrated(): boolean {
  return collectablesHydrated
}

export function subscribeCollectables(listener: CollectablesListener): () => void {
  collectablesListeners.add(listener)
  listener(getCachedCollectables())
  return () => {
    collectablesListeners.delete(listener)
  }
}

export function normalizeOutpoint(outpoint: string): string {
  return outpoint.includes('_') ? outpoint.replace(/_(\d+)$/, '.$1') : outpoint
}

export function shortOrigin(origin: string): string {
  const underscored = origin.includes('.') ? origin.replace(/\.(\d+)$/, '_$1') : origin
  const [txid, vout] = underscored.split('_')
  if (!txid) return origin
  return `${txid.slice(0, 8)}…_${vout ?? '?'}`
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function parseOrigin(raw: string | undefined, fallbackOutpoint: string): string {
  const source = raw?.trim() || fallbackOutpoint
  return source.includes('.') ? source.replace(/\.(\d+)$/, '_$1') : source
}

function parseCustom(raw: string | undefined): {
  origin?: string
  name?: string
  app?: string
  provenance?: unknown
} {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      origin: typeof o.origin === 'string' ? o.origin : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      app: typeof o.app === 'string' ? o.app : undefined,
      provenance: o.provenance,
    }
  } catch {
    return {}
  }
}

function toCollectable(
  o: {
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
  },
  chain: Chain,
  resolved?: Partial<ResolvedInscription> | null,
): Collectable {
  const custom = parseCustom(o.customInstructions)
  const origin = parseOrigin(
    custom.origin ?? tagValue(o.tags, 'origin:') ?? resolved?.origin,
    o.outpoint,
  )
  const name =
    custom.name ?? tagValue(o.tags, 'name:') ?? resolved?.name ?? shortOrigin(origin)
  const app = custom.app ?? tagValue(o.tags, 'app:') ?? resolved?.app
  const proven = verifyProvenance(custom.provenance, o.outpoint).proven
  // When remittance fails, do not treat sender name/app as authoritative — keep for UX
  // but proven=false. Indexer-resolved fields remain display aids.
  return {
    outpoint: normalizeOutpoint(o.outpoint),
    origin,
    name: name.trim() || shortOrigin(origin),
    app,
    imageUrl: contentUrlForOrigin(origin, chain),
    satoshis: o.satoshis,
    mimeType: resolved?.mimeType,
    type: resolved?.type,
    subType: resolved?.subType,
    collectionId: resolved?.collectionId,
    traits: resolved?.traits ?? [],
    extras: resolved?.extras ?? [],
    proven,
  }
}

export async function listCollectables(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return []

  let outputs: Array<{
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
  }> = []

  try {
    const result = await wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 1000,
      includeTags: true,
      includeCustomInstructions: true,
      seekPermission: false,
    })
    outputs = (result.outputs ?? []).map((o) => ({
      outpoint: o.outpoint,
      satoshis: o.satoshis ?? 1,
      tags: o.tags,
      customInstructions: o.customInstructions,
    }))
  } catch (err) {
    console.warn('[collectables] listOutputs failed', err)
    // Keep prior cache — do not hydrate as empty on transient failures.
    return getCachedCollectables()
  }

  const chain: Chain = wallet.chain
  const items: Collectable[] = []

  for (const o of outputs) {
    let resolved: ResolvedInscription | null = null
    const custom = parseCustom(o.customInstructions)
    const hasName = !!(custom.name ?? tagValue(o.tags, 'name:'))
    try {
      const [txid, voutStr] = normalizeOutpoint(o.outpoint).split('.')
      const vout = Number(voutStr)
      // Always try resolve for traits when listing is small; skip deep walk if named.
      if (txid && Number.isInteger(vout)) {
        resolved = await resolveOneSatInscription(txid, vout, chain, hasName ? 2 : 6)
      }
    } catch {
      // keep fallbacks
    }
    items.push(toCollectable(o, chain, resolved))
  }

  setCollectablesCache(items)
  return items
}

export async function getCollectable(
  outpoint: string,
  active?: ActiveWallet | null,
): Promise<Collectable | null> {
  const target = normalizeOutpoint(outpoint)
  const wallet = active ?? getActiveWallet()
  const cached = cachedCollectables.find((i) => i.outpoint === target)
  let item = cached ?? (await listCollectables(active)).find((i) => i.outpoint === target) ?? null
  if (!item || !wallet) return item

  // Details view: refresh indexer metadata (traits, etc.) even if list cache is thin.
  try {
    const [txid, voutStr] = item.outpoint.split('.')
    const vout = Number(voutStr)
    if (txid && Number.isInteger(vout)) {
      const resolved = await resolveOneSatInscription(txid, vout, wallet.chain, 6)
      if (resolved) {
        item = {
          ...item,
          origin: resolved.origin || item.origin,
          name: resolved.name?.trim() || item.name,
          app: resolved.app ?? item.app,
          mimeType: resolved.mimeType ?? item.mimeType,
          type: resolved.type ?? item.type,
          subType: resolved.subType ?? item.subType,
          collectionId: resolved.collectionId ?? item.collectionId,
          traits: resolved.traits.length ? resolved.traits : item.traits,
          extras: resolved.extras.length ? resolved.extras : item.extras,
          imageUrl: contentUrlForOrigin(resolved.origin || item.origin, wallet.chain),
        }
        setCollectablesCache(
          cachedCollectables.map((c) => (c.outpoint === target ? item! : c)),
        )
      }
    }
  } catch (err) {
    console.warn('[collectables] detail enrich failed', err)
  }

  return item
}

function formatSendError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.name || ''
    const msg = err.message || String(err)
    if (name.includes('INSUFFICIENT_FUNDS') || /insufficient.?funds/i.test(msg)) {
      return new Error('Not enough BSV to cover the network fee for this transfer')
    }
    // Must not match `unlockingScript` — that is a signing fault, not a bad recipient.
    if (/invalid.*(address|identity key)/i.test(msg) || /outputs\[\d+]\.lockingScript/i.test(msg)) {
      return new Error('Invalid recipient address or identity key')
    }
    return err
  }
  return new Error(String(err))
}

/**
 * Ordinals reach basket `1sat` locked to this device's root-key address — both the
 * migration sweep and peer transfers pay `addressFromIdentityKey`. Anything else
 * cannot be unlocked here, so say so instead of failing inside the signer.
 */
function assertOrdinalIsDeviceLocked(
  lockingScript: string | undefined,
  wallet: ActiveWallet,
): void {
  if (!lockingScript) return
  const expected = new P2PKH().lock(wallet.address).toHex()
  if (lockingScript.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      'This collectable is locked to a key this device cannot sign. Restore the wallet that received it, then send again.',
    )
  }
}

/**
 * BRC-100 only auto-signs the wallet's own BRC-29 change, so an ordinal listed in
 * `inputs` comes back as a signable transaction for us to unlock with the root key.
 */
async function signOrdinalTransfer(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  outpoint: string
}): Promise<string> {
  const [txidIn, voutRaw] = args.outpoint.split('.')
  const vout = Number(voutRaw)

  const beef = Beef.fromBinary(args.signable.tx)
  let unsigned: Transaction | undefined
  let vin = -1
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      if (
        String(input?.sourceTXID).toLowerCase() === txidIn?.toLowerCase() &&
        input?.sourceOutputIndex === vout
      ) {
        unsigned = btx.tx
        vin = i
        break
      }
    }
    if (unsigned) break
  }
  if (!unsigned || vin < 0) {
    throw new Error('Collectable input missing from the signable transaction')
  }

  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  unsigned.inputs[vin]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(rootKey, 1)
  await unsigned.sign()
  const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
  if (!unlockingScript) throw new Error('Could not sign the collectable transfer')

  const signed = await args.wallet.wallet.signAction({
    reference: args.signable.reference,
    spends: { [vin]: { unlockingScript } },
  })
  if (!signed.txid) throw new Error('Collectable transfer returned no txid')
  return signed.txid
}

/**
 * Transfer a basket `1sat` ordinal to a P2PKH address via BRC-100 createAction.
 *
 * Ordinal sat stays on output 0 (`randomizeOutputs: false`). Fees are funded
 * from the default change basket. Origin/name/app tags match import metadata
 * so recipients (and our activity trail) can resolve the inscription.
 */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  name?: string
  origin?: string
  app?: string
}): Promise<{ txid: string }> {
  return runExclusiveSpend(async () => {
    assertOnlineForPayment()
    await prepareSpendHeal()
    const wallet = getActiveWallet()
    if (!wallet) throw new Error('Wallet locked')

  const outpoint = normalizeOutpoint(args.outpoint)
  const to = resolvePaymentAddress(args.toAddress, wallet.chain)

  let lockingScript: string
  try {
    lockingScript = new P2PKH().lock(to).toHex()
  } catch {
    throw new Error('Invalid recipient address or identity key')
  }

  const held = await wallet.wallet.listOutputs({
    basket: '1sat',
    limit: 1000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const match = (held.outputs ?? []).find(
    (o) => normalizeOutpoint(o.outpoint) === outpoint,
  )
  if (!match) throw new Error('Collectable is no longer in this wallet')
  if ((match.satoshis ?? 1) !== 1) {
    throw new Error('Collectable UTXO is not a 1-sat ordinal')
  }
  assertOrdinalIsDeviceLocked(match.lockingScript, wallet)

  const item = (await getCollectable(outpoint, wallet)) ?? null
  const origin = parseOrigin(args.origin ?? item?.origin, outpoint)
  const name =
    (args.name ?? item?.name ?? 'Collectable').trim().slice(0, 40) || 'Collectable'
  const app = args.app ?? item?.app
  const originTag = origin.replace(/_(\d+)$/, '.$1')
  const tags = [
    'ordinal',
    `origin:${originTag}`,
    `name:${name.slice(0, 80)}`,
    ...(app ? [`app:${app.slice(0, 40)}`] : []),
  ]

  const [txidIn] = outpoint.split('.')
  let inputBEEF: number[] | undefined
  try {
    if (txidIn && wallet.services?.getBeefForTxid) {
      const beef = await wallet.services.getBeefForTxid(txidIn)
      if (beef && typeof beef.toBinary === 'function') {
        inputBEEF = beef.toBinary()
      }
    }
  } catch (err) {
    console.warn('[collectables] inputBEEF fetch skipped', err)
  }

  // BRC-150: build remittance for the tip being spent. Tip on the *new* outpoint is
  // unknown until after createAction — we attach input-tip provenance when it fits
  // budget (omit if oversized). Receivers verify against the tip they hold; mismatch
  // ⇒ unproven (honest) until post-broadcast tip rewrite lands.
  const provenance = await tryBuildProvenanceForSend({
    tipOutpoint: outpoint,
    origin,
    wallet,
    contentType: item?.mimeType,
  })

  let result: { txid?: string; signableTransaction?: SignableTransaction }
  try {
    result = await wallet.wallet.createAction({
      description: `Send ${name}`.slice(0, 50),
      labels: ['1sat', 'handcash-send-collectable'],
      ...(inputBEEF ? { inputBEEF } : {}),
      inputs: [
        {
          outpoint,
          inputDescription: '1sat collectable',
          // P2PKH sig + pubkey. Required by BRC-100 validation, and it makes the
          // ordinal a caller-signed input (see signOrdinalTransfer).
          unlockingScriptLength: 108,
        },
      ],
      outputs: [
        {
          lockingScript,
          satoshis: 1,
          outputDescription: 'Collectable transfer',
          basket: '1sat',
          tags,
          customInstructions: buildCollectableCustomInstructions({
            origin,
            name,
            app,
            provenance,
          }),
        },
      ],
      options: {
        trustSelf: 'known',
        ...(txidIn ? { knownTxids: [txidIn] } : {}),
        randomizeOutputs: false,
        // Surface broadcast errors immediately for ordinal transfers.
        acceptDelayedBroadcast: false,
        signAndProcess: true,
      },
    })
  } catch (err) {
    throw formatSendError(err)
  }

  let txid = result.txid
  if (!txid) {
    if (!result.signableTransaction) throw new Error('Send completed without txid')
    try {
      txid = await signOrdinalTransfer({
        wallet,
        signable: result.signableTransaction,
        outpoint,
      })
    } catch (err) {
      throw formatSendError(err)
    }
  }

  setCollectablesCache(cachedCollectables.filter((i) => i.outpoint !== outpoint))
  scheduleHistoryBackupPush('sendCollectable')
  void listCollectables(wallet).catch((err) => {
    console.warn('[collectables] post-send refresh failed', err)
  })
  return { txid }
  })
}
