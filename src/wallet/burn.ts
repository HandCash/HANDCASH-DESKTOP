import {
  Beef,
  createNonce,
  P2PKH,
  PrivateKey,
  PublicKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { upsertAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { getBeefForTxidCached, rememberBeefTree } from './beefCache'
import {
  type BurnInput,
  type BurnPlan,
  burnRecoveryOutputSatoshis,
  planBsv21Burn,
  planOneSatBurn,
} from './burnPlan'
import { burnMachine } from './burnMachine'
import { estimateBurnEconomics, type BurnEconomics } from './burnEconomics'
import {
  buildBsv21BurnLockingScript,
  buildBsv21TransferLockingScript,
} from './bsv21Inscribe'
import {
  BSV21_BASKET,
  bsv21Tags,
  buildBsv21CustomInstructions,
  normalizeTokenId,
  type Bsv21Utxo,
} from './bsv21'
import { refreshFromChainDuringSpend } from './chainIngest'
import { getCachedCollectables, listCollectables } from './collectables'
import { scheduleHistoryBackupPush } from './deviceSync'
import { getFungible, listFungibleTips, listFungibles } from './fungibles'
import { stampBrc164Id } from './itemAccess'
import { withVisibleOnChainBeef } from './legacyBeef'
import { scriptPaysAddress } from './ordinalOwnership'
import { assertOnlineForPayment } from './paymentPolicy'
import { BRC29_PROTOCOL_ID, ensurePaymentBroadcasted } from './sendBrc29Payment'
import { getActiveWallet, type ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'
import { sealSpentInputsOfSignedTx } from './staleOutputRelease'

type SelfPayment = {
  lockingScript: string
  derivationPrefix: string
  derivationSuffix: string
}

function wireOutpoint(outpoint: string): string {
  return outpoint
    .trim()
    .toLowerCase()
    .replace(/_(\d+)$/, '.$1')
}

async function deriveSelfPayment(active: ActiveWallet): Promise<SelfPayment> {
  const [derivationPrefix, derivationSuffix] = await Promise.all([
    createNonce(active.wallet, 'self'),
    createNonce(active.wallet, 'self'),
  ])
  const keyID = `${derivationPrefix} ${derivationSuffix}`
  const { publicKey } = await active.wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID,
    keyID,
    counterparty: active.identityKey,
  })
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('Failed to derive burn recovery key')
  }
  const address = PublicKey.fromString(publicKey).toAddress(
    active.chain === 'main' ? 'mainnet' : 'testnet'
  )
  return {
    lockingScript: new P2PKH().lock(address).toHex(),
    derivationPrefix,
    derivationSuffix,
  }
}

function resultBeef(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const tx = (result as { tx?: unknown }).tx
  if (tx instanceof Uint8Array) return Array.from(tx)
  if (Array.isArray(tx) && tx.every((n) => typeof n === 'number')) return tx
  return undefined
}

/**
 * Sign every explicitly selected burn input. The source transaction and exact
 * full locking script are required; no P2PKH suffix reconstruction is allowed.
 */
async function signBurnInputs(args: {
  active: ActiveWallet
  signable: SignableTransaction
  inputs: BurnInput[]
}): Promise<{ txid: string; atomicBeef: number[]; feeSatoshis?: number }> {
  const byOutpoint = new Map(
    args.inputs.map((input) => [wireOutpoint(input.outpoint), input])
  )
  const beef = Beef.fromBinary(args.signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs ?? []) {
    if (!btx.tx) continue
    for (let vin = 0; vin < btx.tx.inputs.length; vin += 1) {
      const input = btx.tx.inputs[vin]!
      const outpoint = `${String(input.sourceTXID).toLowerCase()}.${
        input.sourceOutputIndex
      }`
      if (!byOutpoint.has(outpoint)) continue
      unsigned = btx.tx
      vins.push(vin)
    }
    if (unsigned && vins.length === byOutpoint.size) break
  }
  if (!unsigned || vins.length !== byOutpoint.size) {
    throw new Error('Burn inputs are missing from the signable transaction')
  }

  const rootKey = PrivateKey.fromHex(args.active.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    const outpoint = `${String(input.sourceTXID).toLowerCase()}.${
      input.sourceOutputIndex
    }`
    const planned = byOutpoint.get(outpoint)!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    if (!input.sourceTransaction && input.sourceTXID) {
      const sourceBeef = await getBeefForTxidCached(
        args.active,
        String(input.sourceTXID),
        { needProof: true }
      )
      beef.mergeBeef(sourceBeef.toBinary())
      input.sourceTransaction = beef.findTxid(String(input.sourceTXID))?.tx
    }
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (!source)
      throw new Error(`Burn input ${outpoint} is missing its source output`)
    const fullScript = source.lockingScript.toHex().toLowerCase()
    if (fullScript !== planned.lockingScript.toLowerCase()) {
      throw new Error(`Burn input ${outpoint} source locking script changed`)
    }
    if (source.satoshis !== planned.satoshis) {
      throw new Error(`Burn input ${outpoint} source value changed`)
    }
    // Real asset tips are not bare P2PKH: inscription/Sigma envelopes are part
    // of the scriptCode committed by the signature. Rebuilding a bare lock here
    // makes local script verification fail after createAction has already
    // reserved the inputs (the same phantom-item failure phrase migration had).
    input.unlockingScriptTemplate = new P2PKH().unlock(
      rootKey,
      'all',
      false,
      source.satoshis,
      source.lockingScript
    )
  }
  await unsigned.sign()
  const sourceValues = unsigned.inputs.map(
    (input) =>
      input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis
  )
  const outputValues = unsigned.outputs.map((output) => output.satoshis)
  const feeSatoshis =
    sourceValues.every((value): value is number => typeof value === 'number') &&
    outputValues.every((value): value is number => typeof value === 'number')
      ? sourceValues.reduce((sum, value) => sum + value, 0) -
        outputValues.reduce((sum, value) => sum + value, 0)
      : undefined
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign burn input')
    spends[vin] = { unlockingScript }
  }

  const signed = await args.active.wallet.signAction({
    reference: args.signable.reference,
    spends,
    options: { noSend: true },
  })
  const txid =
    typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!txid) throw new Error('Burn returned no txid')
  let atomicBeef = resultBeef(signed)
  if (!atomicBeef?.length) {
    const merged = new Beef()
    merged.mergeBeef(args.signable.tx)
    merged.mergeTransaction(unsigned)
    try {
      atomicBeef = Array.from(merged.toBinaryAtomic(txid))
    } catch {
      atomicBeef = Array.from(merged.toBinary())
    }
  }
  if (!atomicBeef.length) throw new Error('Burn returned no signed BEEF')
  return {
    txid,
    atomicBeef,
    ...(feeSatoshis != null && feeSatoshis >= 0 ? { feeSatoshis } : {}),
  }
}

type BurnOutput = {
  lockingScript: string
  satoshis: number
  outputDescription: string
  basket?: string
  tags?: string[]
  customInstructions?: string
}

export type BurnExecutionEffects = {
  build: () => Promise<{ reference?: string }>
  sign: () => Promise<{ txid: string }>
  broadcast: (txid: string) => Promise<void>
  internalize: (txid: string) => Promise<void>
  relinquish: (txid: string) => Promise<void>
  refresh: () => Promise<void>
  backup: () => void
  abort: (reference?: string) => Promise<void>
}

/** Execute the machine-owned burn phases. Effects are injectable for focused tests. */
export async function executeBurnLifecycle(
  plan: Exclude<BurnPlan, { path: 'refuse' }>,
  effects: BurnExecutionEffects
): Promise<{ txid: string }> {
  const chart = createActor(burnMachine).start()
  chart.send({ type: 'START', plan })
  if (!chart.getSnapshot().matches('building')) {
    chart.stop()
    throw new Error('Burn state machine refused the execution plan')
  }
  let reference: string | undefined
  let signedTxid: string | null = null
  try {
    const built = await effects.build()
    reference = built.reference
    chart.send({ type: 'BUILT', reference })
    const signed = await effects.sign()
    signedTxid = signed.txid
    chart.send({ type: 'SIGNED', txid: signed.txid })
    await effects.broadcast(signed.txid)
    chart.send({ type: 'BROADCASTED' })
    await effects.internalize(signed.txid)
    chart.send({ type: 'INTERNALIZED' })
    await effects.relinquish(signed.txid)
    await effects.refresh()
    chart.send({ type: 'REFRESHED' })
    if (!chart.getSnapshot().matches('done')) {
      throw new Error('Burn state machine did not reach done')
    }
    effects.backup()
    chart.stop()
    return { txid: signed.txid }
  } catch (error) {
    chart.send({
      type: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    })
    // Only an unsigned action is safe to abort. Once a transaction is signed it
    // may already be propagating; releasing its inputs would permit a competing
    // burn. Keep the signed action reserved for review/rebroadcast instead.
    if (!signedTxid) await effects.abort(reference)
    chart.stop()
    throw error
  }
}

async function executeBurnPlan(args: {
  active: ActiveWallet
  plan: Exclude<BurnPlan, { path: 'refuse' }>
  symbol?: string
  icon?: string
  dec?: number
  issuer?: string
}): Promise<{
  txid: string
  recoveredSatoshis: number
  feeSatoshis?: number
}> {
  const self = await deriveSelfPayment(args.active)
  const outputs: BurnOutput[] = []
  if (args.plan.path === 'burnBsv21') {
    const burn = buildBsv21BurnLockingScript({
      address: args.active.address,
      tokenId: args.plan.tokenId,
      amt: args.plan.burnAmount.toString(),
    })
    outputs.push({
      lockingScript: burn.lockingScript,
      satoshis: 1,
      outputDescription: 'BSV-21 burn',
    })
    if (args.plan.changeAmount > 0n) {
      const amount = args.plan.changeAmount.toString()
      outputs.push({
        lockingScript: buildBsv21TransferLockingScript({
          address: args.active.address,
          tokenId: args.plan.tokenId,
          amt: amount,
          sym: args.symbol,
          icon: args.icon,
          dec: args.dec,
        }).lockingScript,
        satoshis: 1,
        outputDescription: `${args.symbol ?? 'Token'} change`,
        basket: BSV21_BASKET,
        tags: stampBrc164Id([
          ...bsv21Tags({
            tokenId: args.plan.tokenId,
            amt: amount,
            sym: args.symbol,
            issuer: args.issuer,
            op: 'transfer',
          }),
        ]),
        customInstructions: buildBsv21CustomInstructions({
          tokenId: args.plan.tokenId,
          amt: amount,
          op: 'transfer',
          sym: args.symbol,
          icon: args.icon,
          dec: args.dec,
          issuer: args.issuer,
        }),
      })
    }
  }
  const recoveryIndex = args.plan.recoverSatoshis > 0 ? outputs.length : -1
  if (args.plan.recoverSatoshis > 0) {
    // A 1Sat identity only ends when its sat is packed into a multi-sat output.
    // A single-item burn therefore tops the self-payment up to 2 sats from
    // managed funding; returning a 1-sat output would silently preserve origin.
    const recoveryOutputSats = burnRecoveryOutputSatoshis(args.plan)
    outputs.push({
      lockingScript: self.lockingScript,
      satoshis: recoveryOutputSats,
      outputDescription: 'Recovered burn satoshis',
      customInstructions: JSON.stringify({
        derivationPrefix: self.derivationPrefix,
        derivationSuffix: self.derivationSuffix,
        payee: args.active.identityKey,
      }),
    })
  }
  if (outputs.length === 0) throw new Error('Burn plan produced no outputs')

  let signable: SignableTransaction | undefined
  let signed:
    | { txid: string; atomicBeef: number[]; feeSatoshis?: number }
    | undefined
  const spendOutpoints = args.plan.inputs.map((input) =>
    wireOutpoint(input.outpoint),
  )
  const knownTxids = [
    ...new Set(
      spendOutpoints
        .map((op) => op.split('.')[0]?.toLowerCase())
        .filter((txid): txid is string => Boolean(txid)),
    ),
  ]
  let inputBEEF: number[] | undefined
  try {
    const { buildMergedInputBeef } = await import('./beefCache')
    inputBEEF = await buildMergedInputBeef(
      args.active,
      spendOutpoints,
      wireOutpoint,
    )
  } catch (err) {
    console.warn('[burn] inputBEEF hydrate failed — createAction may stall', err)
  }

  const result = await executeBurnLifecycle(args.plan, {
    build: async () => {
      const { withFungibleCreateActionTimeout, FUNGIBLE_CREATE_ACTION_TIMEOUT_MS } =
        await import('./sendFungible')
      console.info(
        `[burn] createAction start asset=${args.plan.asset} inputs=${args.plan.inputs.length}`,
      )
      const created = await withFungibleCreateActionTimeout(
        args.active.wallet.createAction({
          description:
            args.plan.path === 'burnBsv21'
              ? 'Burn BSV-21 token'
              : 'Burn collectables',
          labels: ['handcash-burn', args.plan.asset],
          ...(inputBEEF?.length ? { inputBEEF } : {}),
          inputs: args.plan.inputs.map((input) => ({
            outpoint: wireOutpoint(input.outpoint),
            inputDescription: `${args.plan.asset} burn input`,
            unlockingScriptLength: 108,
          })),
          outputs,
          options: {
            trustSelf: 'known',
            ...(knownTxids.length > 0 ? { knownTxids } : {}),
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true,
          },
        }),
        FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
      )
      signable = created.signableTransaction as SignableTransaction | undefined
      if (!signable)
        throw new Error('Burn did not return a signable transaction')
      rememberBeefTree(Array.from(signable.tx))
      console.info(`[burn] createAction signable reference=${signable.reference}`)
      return { reference: signable.reference }
    },
    sign: async () => {
      if (!signable) throw new Error('Burn sign phase has no transaction')
      signed = await signBurnInputs({
        active: args.active,
        signable,
        inputs: args.plan.inputs,
      })
      rememberBeefTree(signed.atomicBeef, signed.txid)
      try {
        await args.active.wallet.actionBatch.abort()
      } catch {
        // Only unused funding reservations remain after signAction.
      }
      return { txid: signed.txid }
    },
    broadcast: async () => {
      if (!signed) throw new Error('Burn broadcast phase has no signed BEEF')
      await sealSpentInputsOfSignedTx(signed.txid, signed.atomicBeef)
      await ensurePaymentBroadcasted(signed.txid, signed.atomicBeef)
    },
    internalize: async () => {
      if (!signed) throw new Error('Burn internalize phase has no signed BEEF')
      if (recoveryIndex < 0) return
      await withVisibleOnChainBeef(() =>
        args.active.wallet.internalizeAction({
          tx: signed!.atomicBeef,
          description: 'Recover burn satoshis',
          labels: ['handcash-burn'],
          outputs: [
            {
              outputIndex: recoveryIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: self.derivationPrefix,
                derivationSuffix: self.derivationSuffix,
                senderIdentityKey: args.active.identityKey,
              },
            },
          ],
          seekPermission: false,
        })
      )
    },
    relinquish: async () => {
      for (const input of args.plan.inputs) {
        try {
          await args.active.wallet.relinquishOutput({
            basket: args.plan.asset === 'bsv21' ? BSV21_BASKET : '1sat',
            output: wireOutpoint(input.outpoint),
          } as never)
        } catch {
          // createAction normally retired it already; refresh is authoritative.
        }
      }
    },
    refresh: () =>
      refreshFromChainDuringSpend({
        forceReview: true,
        announceReceive: false,
      }).then(() => undefined),
    backup: () => scheduleHistoryBackupPush('burn'),
    abort: async (reference) => {
      if (reference) {
        try {
          await args.active.wallet.abortAction({ reference })
        } catch {
          // Preserve the original failure.
        }
      }
      try {
        await args.active.wallet.actionBatch.abort()
      } catch {
        // Best-effort reservation cleanup.
      }
    },
  })
  return {
    txid: result.txid,
    recoveredSatoshis: args.plan.recoverSatoshis,
    ...(signed?.feeSatoshis != null ? { feeSatoshis: signed.feeSatoshis } : {}),
  }
}

async function hydrateBsv21Scripts(
  active: ActiveWallet,
  tips: Bsv21Utxo[]
): Promise<Bsv21Utxo[]> {
  return Promise.all(
    tips.map(async (tip) => {
      if (tip.lockingScript?.trim()) return tip
      const [txid, voutRaw] = wireOutpoint(tip.outpoint).split('.')
      const vout = Number(voutRaw)
      if (!txid || !Number.isInteger(vout) || vout < 0) return tip
      try {
        const beef = await getBeefForTxidCached(active, txid, { needProof: true })
        const lockingScript = beef
          .findTxid(txid)
          ?.tx?.outputs[vout]?.lockingScript?.toHex()
        return lockingScript ? { ...tip, lockingScript } : tip
      } catch {
        return tip
      }
    })
  )
}

function refusalMessage(reason: string): Error {
  return new Error(`Burn refused: ${reason}`)
}

export async function previewBsv21Burn(args: {
  tokenId: string
  amount: string
}): Promise<BurnEconomics> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error('Invalid token id')
  const token = getFungible(tokenId)
  if (!token) throw new Error('Token not found')
  const tips = await hydrateBsv21Scripts(
    active,
    await listFungibleTips(active, {
      tokenIds: token.tokenIds ?? [token.tokenId],
    })
  )
  const plan = planBsv21Burn({
    tokenId,
    amount: args.amount,
    tips,
    ownsLockingScript: (script) => scriptPaysAddress(script, active.address),
  })
  if (plan.path === 'refuse') throw refusalMessage(plan.reason)
  const protocolOutputCount = 1 + (plan.changeAmount > 0n ? 1 : 0)
  return estimateBurnEconomics({
    inputCount: plan.inputs.length,
    protocolOutputCount,
    recoveryOutput: plan.recoverSatoshis > 0,
    grossAssetSats: plan.inputs.reduce((sum, input) => sum + input.satoshis, 0),
  })
}

/** Route burn preview to BSV-21 plan or 1Sat FT tip selection. */
export async function previewFungibleBurn(args: {
  tokenId: string
  amount: string
}): Promise<BurnEconomics> {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error('Invalid token id')
  const token = getFungible(tokenId)
  if (!token) throw new Error('Token not found')
  if (token.colourSupply != null) {
    const { previewColourBurn } = await import('./burnColourCoins')
    return previewColourBurn({ origin: token.tokenId, amount: args.amount })
  }
  return previewBsv21Burn(args)
}

export async function burnBsv21(args: {
  tokenId: string
  amount: string
}): Promise<{ txid: string; recoveredSatoshis: number; feeSatoshis?: number }> {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error('Invalid token id')
  const token = getFungible(tokenId)
  if (!token) throw new Error('Token not found')
  const pendingId = `burn-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`
  const item = {
    name: token.sym,
    origin: token.tokenId,
    tokenId: token.tokenId,
    amt: args.amount,
    dec: token.dec,
    outpoint: token.outpoint,
    ...(token.icon ? { icon: token.icon } : {}),
  }
  // Activity owns progress after the confirmation panel closes. Write this
  // before the spend FIFO and all network hydration so waiting/failure is never
  // invisible.
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: 1,
    method: 'burn-token',
    note: `Burning ${token.sym}`,
    item,
    burn: {
      asset: token.colourSupply != null ? '1sat' : 'bsv21',
      destroyedAmount: args.amount,
    },
    status: 'pending',
    pendingId,
  })
  console.info(
    `[burn] queued token=${tokenId.slice(0, 16)}… pending=${pendingId}`
  )

  // 1Sat FT burns destroy face-value tips (no BSV-21 burn inscription).
  if (token.colourSupply != null) {
    try {
      const { burnColourCoins } = await import('./burnColourCoins')
      const result = await burnColourCoins({
        origin: token.tokenId,
        amount: args.amount,
        sym: token.sym,
        supply: token.colourSupply,
        maxSupply: token.colourMaxSupply ?? null,
        icon: token.icon,
        pendingId,
        item,
      })
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      upsertAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: 1,
        method: 'burn-token',
        note: `${token.sym} was not burned`,
        item,
        burn: { asset: '1sat', destroyedAmount: args.amount },
        status: 'failed',
        pendingId,
        failureReason: reason,
      })
      console.warn(`[burn] failed token=${tokenId.slice(0, 16)}…`, reason)
      throw error
    }
  }

  try {
    return await runExclusiveSpend(async () => {
      assertOnlineForPayment()
      const active = getActiveWallet()
      if (!active) throw new Error('Wallet locked')
      {
        const {
          abortReservedActionBatches,
          releaseStuckNosends,
        } = await import('./actionReview')
        await releaseStuckNosends(active)
        await abortReservedActionBatches(active)
      }
      const tips = await hydrateBsv21Scripts(
        active,
        (
          await listFungibleTips(active, {
            tokenIds: [tokenId],
          })
        ).filter((tip) => normalizeTokenId(tip.tokenId) === tokenId)
      )
      const plan = planBsv21Burn({
        tokenId,
        amount: args.amount,
        tips,
        ownsLockingScript: (script) =>
          scriptPaysAddress(script, active.address),
      })
      if (plan.path === 'refuse') throw refusalMessage(plan.reason)
      const result = await executeBurnPlan({
        active,
        plan,
        symbol: token.sym,
        icon: token.icon,
        dec: token.dec,
        issuer: token.issuer,
      })
      upsertAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: 1,
        method: 'burn-token',
        note: `Burned ${token.sym}`,
        txid: result.txid,
        item,
        burn: {
          asset: 'bsv21',
          destroyedAmount: args.amount,
          recoveredSatoshis: result.recoveredSatoshis,
          ...(result.feeSatoshis != null
            ? { feeSatoshis: result.feeSatoshis }
            : {}),
        },
        status: 'complete',
        pendingId,
      })
      console.info(
        `[burn] complete token=${tokenId.slice(0, 16)}… txid=${result.txid}`
      )
      void listFungibles(active)
      return result
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'burn-token',
      note: `${token.sym} was not burned`,
      item,
      burn: { asset: 'bsv21', destroyedAmount: args.amount },
      status: 'failed',
      pendingId,
      failureReason: reason,
    })
    console.error(`[burn] failed token=${tokenId.slice(0, 16)}…`, reason)
    throw error
  }
}

export async function burnOneSat(
  outpoints: string[]
): Promise<{ txid: string; recoveredSatoshis: number; feeSatoshis?: number }> {
  const wanted = [...new Set(outpoints.map(wireOutpoint).filter(Boolean))]
  if (wanted.length === 0) throw new Error('No collectables selected to burn')
  const pendingId = `burn-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`
  const firstHeld = getCachedCollectables().find(
    (candidate) => wireOutpoint(candidate.outpoint) === wanted[0]
  )
  const item = {
    name:
      outpoints.length === 1
        ? firstHeld?.name ?? 'Collectable'
        : `${outpoints.length} collectables`,
    origin:
      firstHeld?.origin ?? wireOutpoint(outpoints[0] ?? '').replace('.', '_'),
    outpoint: outpoints[0],
    ...(firstHeld?.imageUrl ? { imageUrl: firstHeld.imageUrl } : {}),
    ...(firstHeld?.app ? { app: firstHeld.app } : {}),
  }
  // The panel hands off immediately. Persist its pending row before queueing or
  // fetching source BEEF so Activity always explains what is happening.
  upsertAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: outpoints.length,
    method: 'burn-collectable',
    note: `Burning ${item.name}`,
    item,
    burn: { asset: '1sat', destroyedAmount: String(outpoints.length) },
    status: 'pending',
    pendingId,
  })
  console.info(
    `[burn] queued collectable=${wanted[0]?.slice(0, 16)}… count=${
      wanted.length
    } pending=${pendingId}`
  )

  try {
    return await runExclusiveSpend(async () => {
      assertOnlineForPayment()
      const active = getActiveWallet()
      if (!active) throw new Error('Wallet locked')
      {
        const {
          abortReservedActionBatches,
          releaseStuckNosends,
        } = await import('./actionReview')
        await releaseStuckNosends(active)
        await abortReservedActionBatches(active)
      }
      const heldByOutpoint = new Map(
        getCachedCollectables().map((held) => [
          wireOutpoint(held.outpoint),
          held,
        ]),
      )
      // Resolve keyed source outputs directly. Paging the basket until a selected
      // item appears is both slow and wrong for six-figure inventories.
      const hydrated = await Promise.all(
        wanted.map(async (outpoint) => {
          const held = heldByOutpoint.get(outpoint)
          if (held?.lockingScript) {
            return {
              outpoint,
              satoshis: held.satoshis,
              lockingScript: held.lockingScript,
            }
          }
          const [txid, voutRaw] = outpoint.split('.')
          const vout = Number(voutRaw)
          if (!txid || !Number.isInteger(vout) || vout < 0) {
            return { outpoint, satoshis: 0, lockingScript: undefined }
          }
          try {
            const beef = await getBeefForTxidCached(active, txid, { needProof: true })
            const output = beef.findTxid(txid)?.tx?.outputs[vout]
            return {
              outpoint,
              satoshis: output?.satoshis ?? 0,
              lockingScript: output?.lockingScript?.toHex(),
            }
          } catch (error) {
            console.warn('[burn] source hydrate failed', outpoint, error)
            return {
              outpoint,
              satoshis: 0,
              lockingScript: undefined,
              loadError: error instanceof Error ? error.message : String(error),
            }
          }
        })
      )
      const loadFailure = hydrated.find(
        (tip) => 'loadError' in tip && tip.loadError
      )
      if (loadFailure && 'loadError' in loadFailure) {
        throw new Error(
          `Could not load the source transaction needed to burn this item: ${loadFailure.loadError}`
        )
      }
      const plan = planOneSatBurn({
        tips: hydrated,
        ownsLockingScript: (script) =>
          scriptPaysAddress(script, active.address),
      })
      if (plan.path === 'refuse') throw refusalMessage(plan.reason)
      const result = await executeBurnPlan({ active, plan })
      upsertAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: outpoints.length,
        method: 'burn-collectable',
        note: `Burned ${item.name}`,
        txid: result.txid,
        item,
        burn: {
          asset: '1sat',
          destroyedAmount: String(outpoints.length),
          recoveredSatoshis: result.recoveredSatoshis,
          ...(result.feeSatoshis != null
            ? { feeSatoshis: result.feeSatoshis }
            : {}),
        },
        status: 'complete',
        pendingId,
      })
      console.info(
        `[burn] complete collectable count=${wanted.length} txid=${result.txid}`
      )
      void listCollectables(active)
      return result
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: outpoints.length,
      method: 'burn-collectable',
      note: `${item.name} ${
        outpoints.length === 1 ? 'was' : 'were'
      } not burned`,
      item,
      burn: { asset: '1sat', destroyedAmount: String(outpoints.length) },
      status: 'failed',
      pendingId,
      failureReason: reason,
    })
    console.error(`[burn] failed collectable count=${wanted.length}`, reason)
    throw error
  }
}
