import { pinAccountKeyScope } from '../accountLocalKeys'
import { getActiveWallet } from '../session'

/**
 * Payee ingest of a P2P BSV-21 settle.
 *
 * This is the fungible twin of `internalizePeerItemSettle`: validate the
 * recipient output from Atomic BEEF, let the payee broadcast, then internalize
 * the exact BSV-21 tip into basket `bsv21`. No indexer decides custody.
 * Inbox hints must carry Atomic BEEF; missing BEEF is `missing-beef`, not a
 * WhatsOnChain walk. Miner postBeef runs after internalize.
 */
import { Beef } from '@bsv/sdk'
import type { AtomicBeefPurpose } from '../beefCache'
import {
  BSV21_BASKET,
  buildBsv21CustomInstructions,
  bsv21Tags,
  normalizeTokenId,
  parseBsv21Json,
} from './types'
import {
  atomicBeefForSubject,
  completeAtomicBeefForSubject,
  rememberBeefTree,
} from '../beefCache'
import { scheduleHistoryBackupPush } from '../deviceSync'
import {
  fungibleFromImport,
  hydrateCachedTokenIcons,
  listFungibles,
  rememberFungibleToken,
} from './list'
import {
  beginOneSatImport,
  forgetOneSatImported,
  markOneSatImported,
  markOneSatImportFailed,
} from '../oneSatImportGuard'
import { forgetItemsSent } from '../sentItemGuard'
import { signedChequeAtomic } from '../signedChequeArchive'
import { decodeBsv21Binary } from './decode162'
import { deployDisplayFromScript, type DeployDisplay } from './deployDisplay'
import { fillTokenParentBodies, prove } from './prove176'
import { retainTokenGenesis } from './genesisStore'
import { inboundTokenLineage } from './inboundLineage'
import { chainTrackerFor, provenTokenDeployOf, rememberProvenTokenTips, withTokenLineage } from './lineage'
import { parseOrdEnvelope, scriptPaysAddress } from '../ordinalOwnership'
import { broadcastAtomicBeef } from '../sendBrc29Payment'
import { type ActiveWallet } from '../session'
import { stampBrc164Id } from '../itemAccess'
import {
  clearInboundReceivePending,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
} from '../appActivity'
import type { ItemTransferAsset } from '../messageStore'
import { cacheTokenIconFromBeef } from './icons/resolve'
import {
  alreadyInternalizedError,
  fetchAtomicBeefFromUrl,
  withRestoredInternalizeStatus,
} from '../peerIngestHelpers'

type FungibleAsset = Extract<ItemTransferAsset, { kind: 'fungible' }>

export type IngestFungibleSettleResult = {
  accepted: boolean
  outpoints: string[]
  reason?: string
  /**
   * Parents the package needs that no source could supply. Named so the hint
   * fate can probe *them* — a body we hold is not deliverable when the
   * transaction it spends never existed.
   */
  missingParents?: string[]
}

function deployMetadataFromBeef(beef: Beef, tokenId: string): DeployDisplay | null {
  const [txid, rawVout] = tokenId.split('_')
  const vout = Number(rawVout)
  if (!txid || !Number.isInteger(vout) || vout < 0) return null
  const scriptHex = beef.findTxid(txid)?.tx?.outputs[vout]?.lockingScript?.toHex()
  return deployDisplayFromScript(scriptHex, tokenId)
}

type PayingTip = { vout: number; encoding: 'binary' | 'json' }

/**
 * Outputs of `tokenId` worth `amount` that pay `address`. A self-send has two
 * (the payment and the change) when both amounts match; both are custody.
 */
export function collectFungibleTipsPayingUs(args: {
  outputs: ReadonlyArray<{
    satoshis?: number | null
    lockingScript?: { toHex(): string } | null
  } | null>
  address: string
  tokenId: string
  amount: string
}): { tips: PayingTip[]; sym?: string; icon?: string; issuer?: string } {
  const tips: PayingTip[] = []
  let sym: string | undefined
  let icon: string | undefined
  let issuer: string | undefined
  for (let i = 0; i < args.outputs.length; i++) {
    const output = args.outputs[i]
    const scriptHex = output?.lockingScript?.toHex()
    if (
      output?.satoshis !== 1 ||
      !scriptHex ||
      !scriptPaysAddress(scriptHex, args.address)
    ) {
      continue
    }
    const binary = decodeBsv21Binary(scriptHex)
    if (binary && binary.amount > 0n) {
      const binId = normalizeTokenId(binary.tokenId ?? '') ?? binary.tokenId
      if (binId === args.tokenId && binary.amount.toString() === args.amount) {
        tips.push({ vout: i, encoding: 'binary' })
        continue
      }
    }
    const envelope = parseOrdEnvelope(scriptHex)
    if (!envelope) continue
    let payload: ReturnType<typeof parseBsv21Json> = null
    try {
      payload = parseBsv21Json(JSON.parse(new TextDecoder().decode(envelope.body)))
      sym = sym || payload?.sym
      icon = icon || payload?.icon
      issuer = issuer || payload?.issuer
    } catch {
      // Not a BSV-21 inscription.
    }
    if (
      payload?.op === 'transfer' &&
      payload.id === args.tokenId &&
      payload.amt === args.amount &&
      !tips.some((tip) => tip.vout === i)
    ) {
      tips.push({ vout: i, encoding: 'json' })
    }
  }
  return {
    tips,
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
    ...(issuer ? { issuer } : {}),
  }
}

export async function internalizePeerFungibleSettle(opts: {
  txid: string
  tx?: number[]
  beefUrl?: string
  token: FungibleAsset
  /** Inbox hints race sender postBeef and therefore use a short retry backoff. */
  beefPurpose?: AtomicBeefPurpose
}): Promise<IngestFungibleSettleResult> {
  const id = opts.txid.trim().toLowerCase()
  const tokenId = normalizeTokenId(opts.token.tokenId)
  const amount = opts.token.amount.trim()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, outpoints: [], reason: 'invalid-txid' }
  }
  if (!tokenId || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    return { accepted: false, outpoints: [], reason: 'invalid-token-remittance' }
  }
  const active = getActiveWallet()
  if (!active) return { accepted: false, outpoints: [], reason: 'locked' }

  // Per-account Activity: pin the owner before the awaits below, so switching
  // wallets mid-ingest cannot file the row under the account that is open
  // instead of the one holding the tokens.
  const owner = pinAccountKeyScope(active)
  noteInboundReceivePending({
    txid: id,
    item: true,
    itemName: opts.token.sym,
    token: opts.token,
  }, owner)

  // Every supplied source is re-framed for this subject. `internalizeAction`
  // accepts AtomicBEEF only, while older peers may send a valid plain BEEF.
  let atomic = atomicBeefForSubject(opts.tx, id)
  if (!atomic?.length && opts.beefUrl) {
    atomic = atomicBeefForSubject(
      await fetchAtomicBeefFromUrl(opts.beefUrl),
      id,
    )
  }
  // Inbox settle is remittance + Atomic BEEF. Do not walk WhatsOnChain / the
  // ordinal indexer for a hop the sender already signed — that path 404s on
  // unmined Arcade ghosts and is not how BSV-21 custody works.
  if (!atomic?.length && opts.beefPurpose !== 'inboundItemHint') {
    try {
      const { getAtomicBeefBinaryForTxid } = await import('../beefCache')
      atomic = atomicBeefForSubject(
        await getAtomicBeefBinaryForTxid(active, id, {
          purpose: opts.beefPurpose,
        }),
        id,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/AtomicBEEF backoff/i.test(msg)) {
        console.warn('[fungible-settle] AtomicBEEF fetch failed', id.slice(0, 12), err)
      }
    }
  }
  if (!atomic?.length) {
    clearInboundReceivePending(id)
    return { accepted: false, outpoints: [], reason: 'missing-beef' }
  }

  // The toolbox refuses any package whose unproven ancestors are not all
  // present ("a complete, exactly framed Atomic BEEF transaction"). A lean
  // peer package is a framing problem, not a custody one: fold the parents in
  // from our own signed bodies or a proven copy before asking it to ingest.
  const startedCompletion = Date.now()
  const completion = await completeAtomicBeefForSubject(active, atomic, id)
  if (completion.atomic?.length) atomic = completion.atomic
  if (completion.completed.length > 0) {
    console.info(
      `[fungible-settle] ${id.slice(0, 12)} ancestry completed +${completion.completed.length} parent(s) done ${Date.now() - startedCompletion}ms`,
    )
  }
  if (completion.missing.length > 0) {
    console.warn(
      `[fungible-settle] ${id.slice(0, 12)} ancestry incomplete — missing ${completion.missing.map((p) => p.slice(0, 12)).join(', ')}`,
    )
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: `ancestry-incomplete:${completion.missing.map((p) => p.slice(0, 12)).join(',')}`,
      missingParents: completion.missing,
    }
  }

  /**
   * Every output of this token that pays us the remitted amount. A self-send
   * puts the payment and the change on the same address for the same amount
   * (500 out, 500 back); refusing the second as ambiguous left the row on
   * Receiving forever (hc-a580a, 438497125f03, 2026-09-27).
   */
  const tips: { vout: number; encoding: 'binary' | 'json' }[] = []
  let parsedBeef: Beef | null = null
  let resolvedSym = opts.token.sym
  let resolvedIcon = opts.token.icon
  let resolvedIssuer = opts.token.issuer
  let resolvedDec = opts.token.dec
  try {
    const beef = Beef.fromBinary(atomic)
    parsedBeef = beef
    const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
    if (!tx) {
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'beef-missing-tx' }
    }
    const matched = collectFungibleTipsPayingUs({
      outputs: tx.outputs,
      address: active.address,
      tokenId,
      amount,
    })
    tips.push(...matched.tips)
    if (tips.length === 0) {
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'no-token-tip-paying-us' }
    }

    // BRC-176: what we record is what the packet proves, not what the
    // remittance claims. Walk every accepted tip to its deploy with per-id
    // conservation. The sender's lineage carries the token-parent bodies, so
    // the walk is offline; without it (older peers, over budget) fold them in
    // from our cache or the network (raw bodies; the toolbox does SPV on
    // internalize). A tip that cannot be proven is refused with a name — the
    // hint fate retries when the failure was a fetch, and a forged output
    // naming a real token id never paints a balance.
    const provingStarted = Date.now()
    let proofBeef = withTokenLineage(beef, inboundTokenLineage(id))
    const offline = tips.every((tip) => prove(`${id}_${tip.vout}`, proofBeef, provenTokenDeployOf).ok)
    if (!offline) {
      const { getBeefForTxidCached } = await import('../beefCache')
      proofBeef = await fillTokenParentBodies(
        proofBeef,
        async (txid) => {
          try {
            return await getBeefForTxidCached(active, txid, {
              needProof: false,
              allowUnprovenRawTx: true,
            })
          } catch {
            return null
          }
        },
        [id],
        provenTokenDeployOf,
      )
    }
    let deployOutpoint: string | undefined
    for (const tip of tips) {
      const proof = prove(`${id}_${tip.vout}`, proofBeef, provenTokenDeployOf)
      if (!proof.ok) {
        console.warn(
          `[fungible-settle] ${id.slice(0, 12)}_${tip.vout} BRC-176 unproven — ${proof.reason} (${Date.now() - provingStarted}ms)`,
        )
        clearInboundReceivePending(id)
        return {
          accepted: false,
          outpoints: [],
          reason: `lineage-unproven:${proof.reason.slice(0, 120)}`,
        }
      }
      if (proof.tokenId !== tokenId) {
        clearInboundReceivePending(id)
        return {
          accepted: false,
          outpoints: [],
          reason: `token-id-mismatch:${proof.tokenId.slice(0, 16)}`,
        }
      }
      deployOutpoint = proof.deployOutpoint
    }
    const provingMs = Date.now() - provingStarted
    if (provingMs > 250) {
      console.info(
        `[fungible-settle] ${id.slice(0, 12)} prove done ${provingMs}ms (${offline ? 'lineage' : 'parent walk'})`,
      )
    }
    // The deploy carries the issuer's Sigma; keeping it and the walk that
    // reached it is what lets this token be attested after the tip moves.
    if (deployOutpoint) {
      rememberProvenTokenTips(
        tips.map((tip) => `${id}_${tip.vout}`),
        deployOutpoint,
      )
      const genesisSource = proofBeef
      const deployTxid = deployOutpoint.split('_')[0]!
      void chainTrackerFor(active)
        .then((tracker) => retainTokenGenesis(genesisSource, deployTxid, tracker))
        .catch(() => false)
    }

    // Display data is inherited from the proven deploy (BRC-162 §roles); the
    // sender's envelope and the tip's own inscription only fill gaps.
    const deploy = deployMetadataFromBeef(proofBeef, deployOutpoint ?? tokenId)
    resolvedSym = deploy?.sym || resolvedSym || matched.sym || 'Token'
    resolvedIcon = deploy?.icon || resolvedIcon || matched.icon
    resolvedIssuer = deploy?.issuer || resolvedIssuer || matched.issuer
    resolvedDec = deploy?.dec ?? resolvedDec
    // Superset of the peer package; the icon tx rides here when merged.
    parsedBeef = proofBeef
  } catch (err) {
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const tipVout = tips[0]!.vout
  const tipOp = `${id}.${tipVout}`
  const outpoints = tips.map((tip) => `${id}.${tip.vout}`)
  const paintReceivedToken = (): void => {
    if (resolvedIcon && parsedBeef) {
      cacheTokenIconFromBeef(resolvedIcon, parsedBeef)
    }
    let painted: ReturnType<typeof fungibleFromImport> | null = null
    for (const tip of tips) {
      painted = fungibleFromImport({
        outpoint: `${id}.${tip.vout}`,
        txid: id,
        vout: tip.vout,
        tokenId,
        amt: amount,
        op: 'transfer',
        sym: resolvedSym,
        icon: resolvedIcon,
        dec: resolvedDec,
        issuer: resolvedIssuer,
        ...(tip.encoding === 'binary' ? { binarySupply: 'locked' as const } : {}),
        encoding: tip.encoding === 'binary' ? 'brc162' : 'legacy-json',
      })
      rememberFungibleToken(painted)
    }
    void hydrateCachedTokenIcons(active, painted ? [painted] : []).catch(() => {})
  }
  // A tip we are internalizing now is a tip this account holds, so any hide
  // mark or import claim standing against it is stale. Builds before the
  // guards were scoped per account wrote both device-wide, which is how a
  // same-device transfer arrived hidden from the very wallet that accepted it.
  forgetItemsSent(outpoints)
  const acceptFromBasket = (): IngestFungibleSettleResult => {
    paintReceivedToken()
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: resolvedSym,
      outpoint: tipOp,
      token: {
        ...opts.token,
        sym: resolvedSym,
        dec: resolvedDec,
        ...(resolvedIcon ? { icon: resolvedIcon } : {}),
        ...(resolvedIssuer ? { issuer: resolvedIssuer } : {}),
      },
    }, owner)
    return { accepted: true, outpoints, reason: 'already-imported' }
  }
  // Our own send coming back through the box: createAction already filed these
  // tips in `bsv21`, and internalizing the same transaction again can detach
  // its managed-change row. The signed archive is account-scoped, so this is a
  // self-send, not another wallet on this device receiving it.
  if (signedChequeAtomic(id)?.length) {
    markOneSatImported(outpoints)
    console.info(`[fungible-settle] accepted self-send ${outpoints.join(', ')} from existing basket`)
    return acceptFromBasket()
  }
  let claimed = beginOneSatImport(outpoints)
  if (claimed.length === 0) {
    const held = await Promise.all(
      outpoints.map((op) => basketHoldsTip(active, op)),
    )
    if (held.some((yes) => !yes)) {
      forgetOneSatImported(outpoints)
      claimed = beginOneSatImport(outpoints)
    }
  }
  if (claimed.length === 0) return acceptFromBasket()

  try {
    rememberBeefTree(atomic, id)
    await withRestoredInternalizeStatus(id, () =>
      active.wallet.internalizeAction({
        tx: atomic,
        description: `Receive ${resolvedSym}`.slice(0, 50),
        labels: [BSV21_BASKET, 'handcash-token-p2p'],
        outputs: tips.map((tip) => ({
          outputIndex: tip.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: BSV21_BASKET,
            tags: stampBrc164Id(
              bsv21Tags({
                tokenId,
                amt: amount,
                sym: resolvedSym,
                icon: resolvedIcon,
                issuer: resolvedIssuer,
                op: 'transfer',
              }),
            ),
            customInstructions: buildBsv21CustomInstructions({
              tokenId,
              amt: amount,
              op: 'transfer',
              sym: resolvedSym,
              icon: resolvedIcon,
              dec: resolvedDec,
              issuer: resolvedIssuer,
            }),
          },
        })),
        seekPermission: false,
      }),
    )
    markOneSatImported(outpoints)
    rememberBeefTree(atomic, id)
    paintReceivedToken()
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: resolvedSym,
      outpoint: tipOp,
      token: {
        ...opts.token,
        sym: resolvedSym,
        dec: resolvedDec,
        ...(resolvedIcon ? { icon: resolvedIcon } : {}),
        ...(resolvedIssuer ? { issuer: resolvedIssuer } : {}),
      },
    }, owner)
    scheduleHistoryBackupPush('internalizeFungibleAction')
    void listFungibles(active).catch(() => {})
    // Payee broadcast is best-effort. Custody is the BEEF in basket `bsv21`.
    void broadcastAtomicBeef(id, atomic).catch((err) => {
      console.warn(
        '[fungible-settle] post-internalize broadcast failed',
        id.slice(0, 12),
        err,
      )
    })
    return { accepted: true, outpoints }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(outpoints)
      paintReceivedToken()
      noteInboundReceiveComplete({
        txid: id,
        item: true,
        itemName: resolvedSym,
        outpoint: tipOp,
        token: {
          ...opts.token,
          sym: resolvedSym,
          dec: resolvedDec,
          ...(resolvedIcon ? { icon: resolvedIcon } : {}),
          ...(resolvedIssuer ? { issuer: resolvedIssuer } : {}),
        },
      }, owner)
      void listFungibles(active).catch(() => {})
      void broadcastAtomicBeef(id, atomic).catch(() => {})
      return { accepted: true, outpoints, reason: 'already-imported' }
    }
    markOneSatImportFailed(outpoints)
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Does this account's own `bsv21` basket already hold the tip? */
async function basketHoldsTip(
  active: ActiveWallet,
  tipOp: string,
): Promise<boolean> {
  const wanted = tipOp.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  try {
    const { listBsv21BinaryTips } = await import('./listTips')
    const tips = await listBsv21BinaryTips(active)
    return tips.some(
      (tip) => tip.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1') === wanted,
    )
  } catch {
    // Unknown is not "held": re-claiming an import we already made is safe,
    // internalizeAction refuses a duplicate on its own.
    return false
  }
}

