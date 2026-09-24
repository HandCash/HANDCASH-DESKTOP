import { getActiveWallet } from '../session'

/**
 * Burn BRC-162 value tips: destroy face-value units, keep optional token
 * change, and pack the physical tip sats into managed recovery.
 */
import { createNonce, P2PKH, PublicKey } from '@bsv/sdk'
import { upsertAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { buildMergedInputBeef, rememberBeefTree } from '../beefCache'
import { BSV21_BASKET, requireTokenId } from './types'
import {
  buildBsv21SendRemittance,
  buildBsv21ValueLock,
  planBsv21Send,
  type Bsv21SendTip,
} from './sendPlan'
import { listBsv21BinaryTips } from './listTips'
import { recoverBsv21TipsFromLocalBeef } from './send'
import { scheduleHistoryBackupPush } from '../deviceSync'
import { markItemsSent } from '../sentItemGuard'
import { stampBrc164Id } from '../itemAccess'
import { withVisibleOnChainBeef } from '../legacyBeef'
import { assertOnlineForPayment } from '../paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from '../paymentProgress'
import { BRC29_PROTOCOL_ID } from '../sendBrc29Payment'
import {
  FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
  withFungibleCreateActionTimeout,
} from './sendEntry'
import { type ActiveWallet } from '../session'
import { runExclusiveBurn } from '../spendGuard'
import { estimateBurnEconomics, type BurnEconomics } from '../burnEconomics'

export type Bsv21BurnInventory =
  | { source: 'basket'; tips: Bsv21SendTip[] }
  | { source: 'localBeef'; tips: Bsv21SendTip[] }
  | { source: 'unavailable'; tips: [] }

export async function resolveBsv21BurnInventory(args: {
  listed: Bsv21SendTip[]
  recover: () => Promise<Bsv21SendTip[]>
}): Promise<Bsv21BurnInventory> {
  if (args.listed.length > 0) {
    return { source: 'basket', tips: args.listed }
  }
  const recovered = await args.recover()
  return recovered.length > 0
    ? { source: 'localBeef', tips: recovered }
    : { source: 'unavailable', tips: [] }
}

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

/** Preview BSV-21 tip selection and transaction fee. */
export async function previewBsv21Burn(args: {
  tokenId: string
  amount: string
}): Promise<BurnEconomics> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  const tokenId = requireTokenId(args.tokenId)
  const amount = parseBurnUnits(args.amount)
  const listed = (await listBsv21BinaryTips(active)).filter((t) => t.tokenId === tokenId)
  const plan = planBsv21Send({
    tokenId,
    amount: BigInt(amount),
    tips: listed.map((t) => ({
      outpoint: t.outpoint,
      tokenId: t.tokenId,
      amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
      lockingScript: t.lockingScript,
    })),
  })
  return estimateBurnEconomics({
    inputCount: plan.selected.length,
    protocolOutputCount: plan.changeAmt > 0n ? 1 : 0,
    recoveryOutput: true,
    grossAssetSats: plan.selected.length,
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

export async function burnBsv21Tokens(args: {
  tokenId: string
  /** Face-value units to destroy (decimal string or integer). */
  amount: string
  sym?: string
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
  const tokenId = requireTokenId(args.tokenId)
  const amountRaw = args.amount.trim().replace(/,/g, '')
  const amount = /^\d+$/.test(amountRaw)
    ? Number(amountRaw)
    : Number.parseInt(amountRaw.replace(/\..*$/, ''), 10)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Burn amount must be a positive whole number of units')
  }
  const sym = args.sym?.trim() || 'Token'

  // The spend-priority hold is taken by runExclusiveBurn before the FIFO
  // releases. Without a burn label of our own the pill falls through to the
  // coordinator, which reports every priority hold as "Waiting to send" — so a
  // destroy announced itself as a queued payment for its whole run.
  setPaymentProgress(
    'preparing',
    `Waiting to burn ${sym}`,
    args.item.outpoint ?? null,
    'Burning…',
    'burn',
  )
  return runExclusiveBurn('burn-bsv21', async () => {
    assertOnlineForPayment()
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')
    {
      const { abortReservedActionBatches, releaseStuckNosends } =
        await import('../actionReview')
      await releaseStuckNosends(active)
      await abortReservedActionBatches(active)
    }

    const listed = (await listBsv21BinaryTips(active)).filter(
      (t) => t.tokenId === tokenId,
    )
    const listedTips: Bsv21SendTip[] = listed.map((t) => ({
      outpoint: t.outpoint,
      tokenId: t.tokenId,
      amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
      lockingScript: t.lockingScript,
    }))
    // Heal can hold Toolbox long enough for listOutputs to time out. An empty
    // read is not evidence that the token balance is zero: recover the exact
    // held tips from our cached Atomic BEEF, as the token-send path does.
    const inventory = await resolveBsv21BurnInventory({
      listed: listedTips,
      recover: () => recoverBsv21TipsFromLocalBeef(active, tokenId),
    })
    if (inventory.source === 'unavailable') {
      throw new Error(
        'Token inventory is temporarily unavailable while wallet repair is active',
      )
    }
    const plan = planBsv21Send({
      tokenId,
      amount: BigInt(amount),
      tips: inventory.tips,
    })
    const selected = plan.selected
    const change = Number(plan.changeAmt)

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
    const outputs: Array<{
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      tags?: string[]
      customInstructions: string
    }> = []
    if (change > 0) {
      const remit = buildBsv21SendRemittance({
        tokenId,
        amt: BigInt(change),
        sym,
        dec: 0,
      })
      outputs.push({
        lockingScript: buildBsv21ValueLock({
          tokenId,
          amount: BigInt(change),
          address: active.address,
        }),
        satoshis: 1,
        outputDescription: 'BSV-21 burn change',
        basket: remit.basket,
        tags: stampBrc164Id([
          ...remit.tags,
          ...(args.icon ? [`icon:${args.icon}`] : []),
        ]),
        customInstructions: remit.customInstructions,
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

    setPaymentProgress('building', 'Destroying on chain')
    console.info(
      `[bsv21-burn] createAction start tips=${selected.length} amount=${amount} change=${change}`,
    )
    const created = await withFungibleCreateActionTimeout(
      active.wallet.createAction({
        description: `Burn ${sym}`.slice(0, 50),
        labels: ['handcash-burn', BSV21_BASKET],
        inputBEEF,
        inputs: selected.map((tip) => ({
          outpoint: wireOutpoint(tip.outpoint),
          inputDescription: 'BSV-21 value burn',
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
      setPaymentProgress('signing', 'Signing the burn transaction')
      console.info('[bsv21-burn] createAction returned signable — unlocking tip(s)')
      const { signBsv21TipTransfer } = await import('./send')
      try {
        const signed = await signBsv21TipTransfer({
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

    setPaymentProgress('broadcasting', 'Broadcasting the burn')
    const {
      registerSignedSend,
      startSignedSendPropagation,
    } = await import('../signedSendLifecycle')
    const signedBurn = await registerSignedSend({
      txid,
      atomicBeef: atomic,
      flow: 'burn',
      satoshis: 1,
      to: active.address,
    })
    startSignedSendPropagation(signedBurn)

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
      console.warn('[bsv21-burn] recovery internalize skipped', err)
    }

    for (const tip of selected) {
      try {
        await active.wallet.relinquishOutput({
          basket: BSV21_BASKET,
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
        asset: 'bsv21',
        destroyedAmount: String(amount),
        recoveredSatoshis: recoverSatoshis,
      },
      status: 'complete',
      pendingId: args.pendingId,
    })
    console.info(`[bsv21-burn] complete txid=${txid}`)
    scheduleHistoryBackupPush('burnBsv21Tokens')
    markItemsSent(
      selected.map((tip) => ({ outpoint: wireOutpoint(tip.outpoint), txid })),
    )
    void import('./list')
      .then(({ paintFungibleAfterSpend }) => {
        const keptOp = change > 0 ? `${txid}_0` : undefined
        paintFungibleAfterSpend({
          tokenId,
          remainingAmt: change,
          outpoint: keptOp,
          sym,
          icon: args.icon,
        })
      })
      .catch(() => {})
    return { txid, recoveredSatoshis: recoverSatoshis }
  }).finally(() => {
    clearPaymentProgress()
  })
}
