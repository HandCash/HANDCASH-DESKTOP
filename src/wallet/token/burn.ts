import { getActiveWallet } from '../session'

/**
 * Burn BRC-162 value tips: destroy face-value units, keep optional token
 * change, and pack the physical tip sats into managed recovery.
 */
import { Beef, createNonce, P2PKH, PublicKey, type SignableTransaction } from '@bsv/sdk'
import { upsertAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { buildMergedInputBeef, rememberBeefTree } from '../beefCache'
import { BSV21_BASKET, requireTokenId } from './types'
import {
  assertBsv21BurnConservation,
  buildBsv21SendRemittance,
  buildBsv21ValueLock,
  planBsv21Send,
  type Bsv21SendTip,
} from './sendPlan'
import { p2pkhScriptHex } from '../ordinalOwnership'
import { listBsv21BinaryTips } from './listTips'
import { chooseBsv21ValueTipPath, recoverBsv21TipsFromLocalBeef } from './send'
import type { Bsv21BurnPlan, BurnRefusalReason } from '../burnPlan'
import { executeBurnLifecycle } from '../burnMachine'
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
  | { source: 'fungibleTips'; tips: Bsv21SendTip[] }
  | { source: 'unavailable'; tips: [] }

export async function resolveBsv21BurnInventory(args: {
  listed: Bsv21SendTip[]
  recover: () => Promise<Bsv21SendTip[]>
  /** Same live-tip path the Tokens panel / send uses when basket decode is empty. */
  listFungibleTips?: () => Promise<Bsv21SendTip[]>
}): Promise<Bsv21BurnInventory> {
  if (args.listed.length > 0) {
    return { source: 'basket', tips: args.listed }
  }
  const recovered = await args.recover()
  if (recovered.length > 0) {
    return { source: 'localBeef', tips: recovered }
  }
  if (args.listFungibleTips) {
    const fromList = await args.listFungibleTips()
    if (fromList.length > 0) {
      return { source: 'fungibleTips', tips: fromList }
    }
  }
  return { source: 'unavailable', tips: [] }
}

/** Token amounts exceed 2^53; a float round-trip would lock the wrong change. */
export function parseBurnUnits(amount: string): bigint {
  const whole = amount.trim().replace(/,/g, '').replace(/\.\d*$/, '')
  const n = /^\d+$/.test(whole) ? BigInt(whole) : 0n
  if (n <= 0n) {
    throw new Error('Burn amount must be a positive whole number of units')
  }
  return n
}

const LOCK_REFUSALS: ReadonlySet<string> = new Set<BurnRefusalReason>([
  'no_tips',
  'unknown_lock',
  'mixed_tips',
  'cosigner_required',
])

/**
 * Select value tips with the send planner, then classify every selected rest
 * script once. Anything but plain P2PKH is a named refusal the burn chart owns.
 * Value tips carry one sat each; recovery packs them into ≥2 so the ordinal
 * identity ends (same rule as a 1sat burn).
 */
export function planBinaryBsv21Burn(args: {
  tokenId: string
  amount: bigint
  tips: Bsv21SendTip[]
}): { plan: Bsv21BurnPlan; selected: Bsv21SendTip[] } {
  const send = planBsv21Send(args)
  const lock = chooseBsv21ValueTipPath(send.selected)
  if (lock.path !== 'plain') {
    const reason: BurnRefusalReason =
      lock.path === 'cosigned'
        ? 'cosigner_required'
        : LOCK_REFUSALS.has(lock.reason)
          ? (lock.reason as BurnRefusalReason)
          : 'unknown_lock'
    return { plan: { path: 'refuse', asset: 'bsv21', reason }, selected: send.selected }
  }
  const changeTips = send.changeAmt > 0n ? 1 : 0
  return {
    plan: {
      path: 'burnBsv21',
      asset: 'bsv21',
      tokenId: send.tokenId,
      burnAmount: args.amount,
      selectedAmount: send.selectedSum,
      changeAmount: send.changeAmt,
      inputs: send.selected.map((tip) => ({
        outpoint: wireOutpoint(tip.outpoint),
        satoshis: 1,
        lockingScript: tip.lockingScript ?? '',
      })),
      recoverSatoshis: Math.max(2, send.selected.length - changeTips),
    },
    selected: send.selected,
  }
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
    amount,
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

type SelfPayment = {
  lockingScript: string
  derivationPrefix: string
  derivationSuffix: string
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
  const amount = parseBurnUnits(args.amount)
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
    const { abortReservedActionBatches, releaseStuckNosends } =
      await import('../actionReview')
    await releaseStuckNosends(active)
    await abortReservedActionBatches(active)

    const listed = (await listBsv21BinaryTips(active)).filter(
      (t) => t.tokenId === tokenId,
    )
    const listedTips: Bsv21SendTip[] = listed
      .filter((t) => !!t.lockingScript)
      .map((t) => ({
        outpoint: t.outpoint,
        tokenId: t.tokenId,
        amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
        lockingScript: t.lockingScript,
      }))
    // Heal / a just-bought tip can make listOutputs look empty. Recover from
    // cached BEEF and the same live-tip path send uses — never invent a
    // "repair is active" refusal when the tips are simply not on the basket
    // read yet.
    const inventory = await resolveBsv21BurnInventory({
      listed: listedTips,
      recover: () => recoverBsv21TipsFromLocalBeef(active, tokenId),
      listFungibleTips: async () => {
        const { listFungibleTips } = await import('./list')
        const rows = await listFungibleTips(active, { tokenIds: [tokenId] })
        return rows
          .filter((t) => !!t.lockingScript)
          .map((t) => ({
            outpoint: t.outpoint,
            tokenId: t.tokenId,
            amt: BigInt(t.amt.replace(/\D/g, '') || '0'),
            lockingScript: t.lockingScript!,
          }))
      },
    })
    if (inventory.source === 'unavailable') {
      throw new Error(
        'No spendable tips found for this token. Open Tokens, pull to refresh, then burn again.',
      )
    }
    console.info(
      `[bsv21-burn] inventory source=${inventory.source} tips=${inventory.tips.length}`,
    )
    const { plan, selected } = planBinaryBsv21Burn({
      tokenId,
      amount,
      tips: inventory.tips,
    })
    if (plan.path === 'refuse') {
      console.warn(`[bsv21-burn] refused before build: ${plan.reason}`)
    }
    const change = plan.path === 'burnBsv21' ? plan.changeAmount : 0n
    const recoverSatoshis = plan.path === 'burnBsv21' ? plan.recoverSatoshis : 0
    const spendOutpoints = selected.map((tip) => wireOutpoint(tip.outpoint))

    let self: SelfPayment | undefined
    let recoveryIndex = 0
    let built: { txid: string; atomic?: number[]; signable?: SignableTransaction } | undefined
    let atomic: number[] = []
    let burnTxid = ''

    const { txid } = await executeBurnLifecycle(plan, {
      build: async () => {
        const knownTxids = [
          ...new Set(
            spendOutpoints
              .map((op) => op.split('.')[0]?.toLowerCase())
              .filter((id): id is string => Boolean(id)),
          ),
        ]
        const inputBEEF = await buildMergedInputBeef(
          active,
          spendOutpoints,
          wireOutpoint,
        )
        const payment = await deriveSelfPayment(active)
        self = payment
        const outputs: Array<{
          lockingScript: string
          satoshis: number
          outputDescription: string
          basket?: string
          tags?: string[]
          customInstructions: string
        }> = []
        if (change > 0n) {
          const remit = buildBsv21SendRemittance({
            tokenId,
            amt: change,
            sym,
            dec: Number.isInteger(args.item.dec) ? args.item.dec : 0,
            ...(args.icon ? { icon: args.icon } : {}),
          })
          outputs.push({
            lockingScript: buildBsv21ValueLock({
              tokenId,
              amount: change,
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
        recoveryIndex = outputs.length
        outputs.push({
          lockingScript: payment.lockingScript,
          satoshis: recoverSatoshis,
          outputDescription: 'Recovered burn satoshis',
          customInstructions: JSON.stringify({
            derivationPrefix: payment.derivationPrefix,
            derivationSuffix: payment.derivationSuffix,
            payee: active.identityKey,
          }),
        })

        setPaymentProgress('building', 'Destroying on chain')
        console.info(
          `[bsv21-burn] createAction start tips=${selected.length} amount=${amount} change=${change}`,
        )
        const createBurnAction = () =>
          withFungibleCreateActionTimeout(
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
        let created: Awaited<ReturnType<typeof createBurnAction>>
        try {
          created = await createBurnAction()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!/no longer spendable|insufficient/i.test(msg)) throw err
          // Fee coin sealed behind an app-held parent — free it and retry once.
          const { healAppHeldChange } = await import('../staleOutputRelease')
          const freed = await healAppHeldChange()
          console.warn(
            `[bsv21-burn] createAction refused (${msg.slice(0, 80)}); healed ${freed} parent(s), retrying`,
          )
          await releaseStuckNosends(active)
          await abortReservedActionBatches(active)
          created = await createBurnAction()
        }
        const createdTxid =
          typeof created.txid === 'string' && /^[0-9a-f]{64}$/i.test(created.txid)
            ? created.txid.toLowerCase()
            : ''
        built = {
          txid: createdTxid,
          atomic: atomicBeefFromWalletResult(created),
          ...(created.signableTransaction ? { signable: created.signableTransaction } : {}),
        }
        return { reference: built.signable?.reference ?? (createdTxid || undefined) }
      },

      // Returns only a transaction whose token outputs conserve the burn: a
      // throw here leaves it unsigned to the chart, which aborts the action.
      sign: async () => {
        if (!built) throw new Error('Token burn was not built')
        let signedTxid = built.txid
        let signedAtomic = built.atomic
        if (!signedTxid) {
          if (!built.signable) throw new Error('Token burn produced no txid')
          setPaymentProgress('signing', 'Signing the burn transaction')
          console.info('[bsv21-burn] createAction returned signable — unlocking tip(s)')
          const { signBsv21TipTransfer } = await import('./send')
          const signed = await signBsv21TipTransfer({
            wallet: active,
            signable: built.signable,
            outpoints: spendOutpoints,
          })
          signedTxid = signed.txid
          signedAtomic = signed.atomicBeef
        }
        if (!signedAtomic?.length) {
          throw new Error('Token burn missing AtomicBEEF for broadcast')
        }
        const signedTx = Beef.fromBinary(signedAtomic).findTxid(signedTxid)?.tx
        if (!signedTx) throw new Error('Signed token burn transaction body is missing')
        try {
          assertBsv21BurnConservation({
            tx: signedTx,
            tokenId,
            changeRestHex: p2pkhScriptHex(active.address),
            changeAmt: change,
          })
        } catch (err) {
          console.warn(`[bsv21-burn] ${signedTxid.slice(0, 12)} refused before broadcast`, err)
          throw err
        }
        atomic = signedAtomic
        burnTxid = signedTxid
        rememberBeefTree(atomic, signedTxid)
        return { txid: signedTxid }
      },

      broadcast: async (signedTxid) => {
        setPaymentProgress('broadcasting', 'Broadcasting the burn')
        const { registerSignedSend, startSignedSendPropagation } = await import(
          '../signedSendLifecycle'
        )
        const signedBurn = await registerSignedSend({
          txid: signedTxid,
          atomicBeef: atomic,
          flow: 'burn',
          satoshis: 1,
          to: active.address,
        })
        startSignedSendPropagation(signedBurn)
      },

      internalize: async () => {
        if (!self) throw new Error('Token burn lost its recovery key')
        const payment = self
        try {
          await withVisibleOnChainBeef(() =>
            active.wallet.internalizeAction({
              tx: atomic,
              description: 'Recover burn satoshis',
              labels: ['handcash-burn'],
              outputs: [
                {
                  outputIndex: recoveryIndex,
                  protocol: 'wallet payment',
                  paymentRemittance: {
                    derivationPrefix: payment.derivationPrefix,
                    derivationSuffix: payment.derivationSuffix,
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
      },

      relinquish: async (signedTxid) => {
        for (const op of spendOutpoints) {
          try {
            await active.wallet.relinquishOutput({
              basket: BSV21_BASKET,
              output: op,
            } as never)
          } catch {
            /* createAction normally retired it */
          }
        }
        markItemsSent(
          spendOutpoints.map((outpoint) => ({ outpoint, txid: signedTxid, asset: 'token' as const })),
        )
      },

      refresh: async () => {
        void import('./list')
          .then(({ paintFungibleAfterSpend }) => {
            paintFungibleAfterSpend({
              tokenId,
              remainingAmt: change,
              outpoint: change > 0n && burnTxid ? `${burnTxid}_0` : undefined,
              sym,
              icon: args.icon,
              dec: Number.isInteger(args.item.dec) ? args.item.dec : undefined,
              binarySupply: 'locked',
            })
          })
          .catch(() => {})
      },

      backup: () => scheduleHistoryBackupPush('burnBsv21Tokens'),

      abort: async (reference) => {
        if (reference) {
          await active.wallet.abortAction({ reference }).catch(() => undefined)
        }
        await active.wallet.actionBatch.abort().catch(() => undefined)
      },
    })

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
    return { txid, recoveredSatoshis: recoverSatoshis }
  }).finally(() => {
    clearPaymentProgress()
  })
}
