/**
 * Burn 1Sat fungibles (BRC-175): spend tip(s), destroy face-value units, keep
 * optional change tip + pack physical tip sats into managed recovery.
 */
import { createNonce, P2PKH, PublicKey } from '@bsv/sdk'
import { upsertAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { buildMergedInputBeef, rememberBeefTree } from './beefCache'
import {
  assertColourAmtConservation,
  buildColourCustomInstructions,
  colourTags,
  normalizeColourOrigin,
  ONESAT_FT_BASKET,
  selectColourTipsForAmount,
  tipFaceAmt,
} from './colourCoins'
import { listColourTipsForOrigin } from './colourListing'
import { scheduleHistoryBackupPush } from './deviceSync'
import { markItemsSent } from './sentItemGuard'
import { stampBrc164Id } from './itemAccess'
import { withVisibleOnChainBeef } from './legacyBeef'
import { assertOnlineForPayment } from './paymentPolicy'
import { BRC29_PROTOCOL_ID, ensurePaymentBroadcasted } from './sendBrc29Payment'
import {
  FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
  withFungibleCreateActionTimeout,
} from './sendFungible'
import { getActiveWallet, type ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'
import { sealSpentInputsOfSignedTx } from './staleOutputRelease'
import { estimateBurnEconomics, type BurnEconomics } from './burnEconomics'

function parseBurnUnits(amount: string): number {
  const amountRaw = amount.trim().replace(/,/g, '')
  const n = /^\d+$/.test(amountRaw)
    ? Number(amountRaw)
    : Number.parseInt(amountRaw.replace(/\..*$/, ''), 10)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error('Burn amount must be a positive whole number of units')
  }
  return n
}

/** Preview tip selection + fee for a 1Sat FT burn (no BSV-21 burn inscription). */
export async function previewColourBurn(args: {
  origin: string
  amount: string
}): Promise<BurnEconomics> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  const origin = normalizeColourOrigin(args.origin)
  const amount = parseBurnUnits(args.amount)
  const listed = await listColourTipsForOrigin(origin, active)
  const cover = selectColourTipsForAmount(listed, amount)
  return estimateBurnEconomics({
    inputCount: cover.selected.length,
    protocolOutputCount: cover.change > 0 ? 1 : 0,
    recoveryOutput: true,
    grossAssetSats: cover.selected.length,
  })
}

function wireOutpoint(op: string): string {
  return op.includes('_') ? op.replace(/_(\d+)$/, '.$1') : op
}

function atomicBeefFromWalletResult(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return undefined
}

async function deriveSelfPayment(active: ActiveWallet): Promise<{
  lockingScript: string
  derivationPrefix: string
  derivationSuffix: string
}> {
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
    active.chain === 'main' ? 'mainnet' : 'testnet',
  )
  return {
    lockingScript: new P2PKH().lock(address).toHex(),
    derivationPrefix,
    derivationSuffix,
  }
}

export async function burnColourCoins(args: {
  origin: string
  /** Face-value units to destroy (decimal string or integer). */
  amount: string
  sym?: string
  supply?: 'locked' | 'open'
  maxSupply?: number | null
  icon?: string
  pendingId: string
  item: {
    name: string
    origin: string
    tokenId: string
    amt: string
    dec: number
    outpoint?: string
    icon?: string
  }
}): Promise<{ txid: string; recoveredSatoshis: number; feeSatoshis?: number }> {
  const origin = normalizeColourOrigin(args.origin)
  const amountRaw = args.amount.trim().replace(/,/g, '')
  const amount = /^\d+$/.test(amountRaw)
    ? Number(amountRaw)
    : Number.parseInt(amountRaw.replace(/\..*$/, ''), 10)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Burn amount must be a positive whole number of units')
  }
  const sym = args.sym?.trim() || 'Token'

  return runExclusiveSpend(async () => {
    assertOnlineForPayment()
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')
    {
      const { abortReservedActionBatches, releaseStuckNosends } =
        await import('./actionReview')
      await releaseStuckNosends(active)
      await abortReservedActionBatches(active)
    }

    const listed = await listColourTipsForOrigin(origin, active)
    const cover = selectColourTipsForAmount(listed, amount)
    const selected = cover.selected
    const change = cover.change
    assertColourAmtConservation(
      selected.map(tipFaceAmt),
      change > 0 ? [amount, change] : [amount],
    )

    const spendOutpoints = selected.map((tip) => wireOutpoint(tip.outpoint))
    const knownTxids = [
      ...new Set(
        spendOutpoints
          .map((op) => op.split('.')[0]?.toLowerCase())
          .filter((txid): txid is string => Boolean(txid)),
      ),
    ]
    const inputBEEF = await buildMergedInputBeef(
      active,
      spendOutpoints,
      wireOutpoint,
    )

    const self = await deriveSelfPayment(active)
    const tags = stampBrc164Id(
      colourTags(origin, [
        `name:${sym.slice(0, 80)}`,
        ...(args.icon ? [`icon:${args.icon}`] : []),
      ]),
    )
    const parentRef = selected[0]!.outpoint
    const baseCi = {
      origin,
      sym,
      name: sym,
      supply: args.supply,
      maxSupply: args.maxSupply ?? null,
      parent: parentRef,
      ...(args.icon ? { icon: args.icon } : {}),
    }

    const outputs: Array<{
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      tags?: string[]
      customInstructions: string
    }> = []
    if (change > 0) {
      outputs.push({
        lockingScript: new P2PKH().lock(active.address).toHex(),
        satoshis: 1,
        outputDescription: '1Sat burn change',
        basket: ONESAT_FT_BASKET,
        tags,
        customInstructions: buildColourCustomInstructions({
          ...baseCi,
          amt: change,
        }),
      })
    }
    // Pack tip sats into ≥2 so ordinal/FT identity ends (same rule as 1sat burn).
    const tipSats = selected.length
    const changeTips = change > 0 ? 1 : 0
    const recoverSatoshis = Math.max(2, tipSats - changeTips)
    const recoveryIndex = outputs.length
    outputs.push({
      lockingScript: self.lockingScript,
      satoshis: recoverSatoshis,
      outputDescription: 'Recovered burn satoshis',
      customInstructions: JSON.stringify({
        derivationPrefix: self.derivationPrefix,
        derivationSuffix: self.derivationSuffix,
        payee: active.identityKey,
      }),
    })

    console.info(
      `[1sat-ft-burn] createAction start tips=${selected.length} amount=${amount} change=${change}`,
    )
    const created = await withFungibleCreateActionTimeout(
      active.wallet.createAction({
        description: `Burn ${sym}`.slice(0, 50),
        labels: ['handcash-burn', ONESAT_FT_BASKET],
        inputBEEF,
        inputs: selected.map((tip) => ({
          outpoint: wireOutpoint(tip.outpoint),
          inputDescription: '1Sat tip burn',
          unlockingScriptLength: 108,
        })),
        outputs,
        options: {
          trustSelf: 'known',
          ...(knownTxids.length > 0 ? { knownTxids } : {}),
          noSend: true,
          randomizeOutputs: false,
          signAndProcess: true,
        },
      }),
      FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
    )

    let txid =
      typeof created.txid === 'string' && /^[0-9a-f]{64}$/i.test(created.txid)
        ? created.txid.toLowerCase()
        : ''
    let atomic = atomicBeefFromWalletResult(created)

    if (!txid) {
      const signable = created.signableTransaction
      if (!signable) throw new Error('Token burn produced no txid')
      console.info('[1sat-ft-burn] createAction returned signable — unlocking tip(s)')
      const { signColourTipTransfer } = await import('./sendColourCoins')
      try {
        const signed = await signColourTipTransfer({
          wallet: active,
          signable,
          outpoints: spendOutpoints,
        })
        txid = signed.txid
        atomic = signed.atomicBeef
      } catch (err) {
        try {
          await active.wallet.abortAction({ reference: signable.reference })
        } catch {
          /* preserve original failure */
        }
        try {
          await active.wallet.actionBatch.abort()
        } catch {
          /* best-effort */
        }
        throw err
      }
    }

    if (!atomic?.length) {
      throw new Error('Token burn missing AtomicBEEF for broadcast')
    }
    rememberBeefTree(atomic, txid)

    try {
      await active.wallet.actionBatch.abort()
    } catch {
      /* unused funding */
    }

    await sealSpentInputsOfSignedTx(txid, atomic)
    await ensurePaymentBroadcasted(txid, atomic)

    try {
      await withVisibleOnChainBeef(() =>
        active.wallet.internalizeAction({
          tx: atomic!,
          description: 'Recover burn satoshis',
          labels: ['handcash-burn'],
          outputs: [
            {
              outputIndex: recoveryIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: self.derivationPrefix,
                derivationSuffix: self.derivationSuffix,
                senderIdentityKey: active.identityKey,
              },
            },
          ],
          seekPermission: false,
        }),
      )
    } catch (err) {
      console.warn('[1sat-ft-burn] recovery internalize skipped', err)
    }

    for (const tip of selected) {
      try {
        await active.wallet.relinquishOutput({
          basket: ONESAT_FT_BASKET,
          output: wireOutpoint(tip.outpoint),
        } as never)
      } catch {
        /* createAction normally retired it */
      }
    }

    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'burn-token',
      note: `Burned ${sym}`,
      txid,
      item: args.item,
      burn: {
        asset: '1sat',
        destroyedAmount: String(amount),
        recoveredSatoshis: recoverSatoshis,
      },
      status: 'complete',
      pendingId: args.pendingId,
    })
    console.info(`[1sat-ft-burn] complete txid=${txid}`)
    scheduleHistoryBackupPush('burnColourCoins')
    markItemsSent(
      selected.map((tip) => ({ outpoint: wireOutpoint(tip.outpoint), txid })),
    )
    void Promise.all([import('./fungibles'), import('./onesatFtLeftover')])
      .then(([{ paintFungibleAfterSpend }, { rememberOnesatFtLeftover, forgetOnesatFtLeftover }]) => {
        const keptOp = change > 0 ? `${txid}_0` : undefined
        paintFungibleAfterSpend({
          tokenId: origin,
          remainingAmt: change,
          outpoint: keptOp,
          sym,
          colourSupply: args.supply,
          colourMaxSupply: args.maxSupply ?? null,
          icon: args.icon,
        })
        if (change > 0 && keptOp) {
          rememberOnesatFtLeftover({
            origin,
            amt: change,
            outpoint: keptOp,
            ci: buildColourCustomInstructions({
              origin,
              amt: change,
              sym,
              supply: args.supply,
              maxSupply: args.maxSupply ?? null,
              issuer: (() => {
                for (const tip of selected) {
                  try {
                    const o = JSON.parse(String(tip.customInstructions ?? '')) as {
                      issuer?: unknown
                    }
                    if (typeof o.issuer === 'string' && o.issuer.trim()) return o.issuer
                  } catch {
                    /* next tip */
                  }
                }
                return undefined
              })(),
            }),
            sym,
            supply: args.supply,
            maxSupply: args.maxSupply ?? null,
          })
        } else {
          forgetOnesatFtLeftover(origin)
        }
      })
      .catch(() => {})
    return { txid, recoveredSatoshis: recoverSatoshis }
  })
}
