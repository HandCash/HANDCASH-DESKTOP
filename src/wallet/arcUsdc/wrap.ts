/**
 * Lab wrap: Arc USDC deposit → BNT-backed claim units on BSV, and redeem back.
 *
 * Missing link: each deposit mints (or deploys) a BNT asset with `bk: { chain:
 * 'arc', reserve }` and an Arc Transfer receipt as the backing proof. Redeem
 * burns those BNT units then pays USDC on Arc from the reserve.
 *
 * Mint / burn / payout / verify are injectable so unit tests prove the
 * orchestration without a live wallet or Arc RPC.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import {
  arcDepositOutpoint,
  arcReceiptProofOf,
  arcReserveHex,
  ERC20_TRANSFER_TOPIC,
  type ArcReceiptProof,
} from './backing'
import { assertEthAddress, bytesToHex } from './address'
import { ARC_USDC_ERC20, type ArcNetwork } from './chain'
import { decodeUint256 } from './erc20'
import {
  arcUsdcLabEnabled,
  planFractionalize,
  planRedeem,
  type ArcUsdcAtoms,
  type ArcUsdcDeposit,
  type FractionalizePlan,
} from './fractionalize'
import { createArcRpc, type ArcRpc } from './rpc'

export { ERC20_TRANSFER_TOPIC, padAddressTopic } from './backing'

export type DepositSighting = {
  atoms: ArcUsdcAtoms
  /** Recipient of the USDC Transfer. */
  to: string
  tokenAddress: string
  /** Log body when verify saw a receipt (needed to build the Arc proof). */
  log?: { address: string; topics: string[]; data: string }
}

export type VerifyArcDeposit = (deposit: ArcUsdcDeposit) => Promise<DepositSighting>

export type PayoutArcUsdc = (args: {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  to: string
}) => Promise<{ txHash: string }>

/** Mint BNT units against a verified Arc deposit (production: issue/mint + prove). */
export type MintWrapUnits = (args: {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  deposit: { txHash: string; logIndex: number }
  reserveAddress: string
  proof: ArcReceiptProof
  existingAssetId: string | null
}) => Promise<{ assetId: string; mintTxid: string; spendable: ArcUsdcAtoms }>

/** Burn BNT units before Arc payout (production: burnBntUnits). */
export type BurnWrapUnits = (args: {
  assetId: string
  atoms: ArcUsdcAtoms
}) => Promise<{ burnTxid: string; spendable: ArcUsdcAtoms }>

export type WrapClaim = {
  id: string
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  deposit: { txHash: string; logIndex: number }
  mintTxid: string
  assetId: string
  wrappedAt: number
}

export type WrapRedeem = {
  atoms: ArcUsdcAtoms
  to: string
  txHash: string
  burnTxid: string
  at: number
  assetId: string
  network: ArcNetwork
}

type WrapStore = {
  assetId: string | null
  /** Deposit journal (one entry per mint); spendable comes from BNT / mint hook. */
  claims: Record<string, WrapClaim>
  redeems: WrapRedeem[]
  /** Last known spendable atoms from mint/burn (BNT balance mirror). */
  spendable: ArcUsdcAtoms
}

export type WrapResult = {
  claim: WrapClaim
  plan: FractionalizePlan
  assetId: string
  mintTxid: string
  spendable: ArcUsdcAtoms
  status: 'wrapped'
}

export type RedeemResult = {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  to: string
  assetId: string
  burnTxid: string
  redeemTxHash: string
  spendable: ArcUsdcAtoms
  status: 'redeemed'
}

export class ArcWrapRefusalError extends Error {
  constructor(
    readonly reason:
      | 'lab-off'
      | 'bad-args'
      | 'deposit-mismatch'
      | 'already-wrapped'
      | 'insufficient'
      | 'payout-failed'
      | 'mint-failed'
      | 'burn-failed',
    message: string,
  ) {
    super(message)
    this.name = 'ArcWrapRefusalError'
  }
}

let verifyOverride: VerifyArcDeposit | null = null
let payoutOverride: PayoutArcUsdc | null = null
let mintOverride: MintWrapUnits | null = null
let burnOverride: BurnWrapUnits | null = null
let rpcOverride: ArcRpc | null = null
let reserveOverride: string | null = null
const listeners = new Set<() => void>()

function storeKey(): string {
  return accountLocalKey(storageRegistry.arcUsdWrap.key)
}

function emptyStore(): WrapStore {
  return { assetId: null, claims: {}, redeems: [], spendable: '0' }
}

function readStore(): WrapStore {
  try {
    const raw = durableGetItem(storeKey())
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<WrapStore>
    if (!parsed || typeof parsed !== 'object') return emptyStore()
    return {
      assetId: typeof parsed.assetId === 'string' ? parsed.assetId : null,
      claims: parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {},
      redeems: Array.isArray(parsed.redeems) ? parsed.redeems : [],
      spendable: typeof parsed.spendable === 'string' ? parsed.spendable : '0',
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(next: WrapStore): void {
  durableSetItem(storeKey(), JSON.stringify(next))
  for (const listener of listeners) listener()
}

export function depositClaimId(network: ArcNetwork, txHash: string, logIndex: number): string {
  return `${network}:${txHash.toLowerCase()}:${logIndex}`
}

export function listWrapClaims(): WrapClaim[] {
  return Object.values(readStore().claims).sort((a, b) => a.wrappedAt - b.wrappedAt)
}

export function listWrapRedeems(): WrapRedeem[] {
  return [...readStore().redeems]
}

export function getWrapSpendable(): ArcUsdcAtoms {
  return readStore().spendable
}

export function getWrapAssetId(): string | null {
  return readStore().assetId
}

export function subscribeWrap(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setWrapVerifyForTest(next: VerifyArcDeposit | null): void {
  verifyOverride = next
}

export function setWrapPayoutForTest(next: PayoutArcUsdc | null): void {
  payoutOverride = next
}

export function setWrapMintForTest(next: MintWrapUnits | null): void {
  mintOverride = next
}

export function setWrapBurnForTest(next: BurnWrapUnits | null): void {
  burnOverride = next
}

export function setWrapRpcForTest(next: ArcRpc | null): void {
  rpcOverride = next
}

export function setWrapReserveForTest(next: string | null): void {
  reserveOverride = next
}

export function resetWrapStoreForTest(): void {
  writeStore(emptyStore())
}

function requireLab(): void {
  if (!arcUsdcLabEnabled()) {
    throw new ArcWrapRefusalError(
      'lab-off',
      'ARC_USDC_LAB: turn on Settings → Labs → Wrap USDC (Arc) on this device first',
    )
  }
}

function refuse(reason: ArcWrapRefusalError['reason'], message: string): never {
  throw new ArcWrapRefusalError(reason, message)
}

export function sightingFromReceiptLog(
  deposit: ArcUsdcDeposit,
  log: {
    address?: string
    topics?: string[]
    data?: string
    logIndex?: number | string
  },
): DepositSighting {
  const topics = log.topics ?? []
  if (topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) {
    refuse('deposit-mismatch', 'ARC_USDC_LOG: expected an ERC-20 Transfer event')
  }
  const token = (log.address ?? '').toLowerCase()
  if (token !== ARC_USDC_ERC20.toLowerCase()) {
    refuse('deposit-mismatch', `ARC_USDC_TOKEN: log token ${token} is not Arc USDC`)
  }
  const logIndex =
    typeof log.logIndex === 'string' ? Number.parseInt(log.logIndex, 16) : Number(log.logIndex)
  if (logIndex !== deposit.logIndex) {
    refuse('deposit-mismatch', `ARC_USDC_LOG: logIndex ${logIndex} ≠ ${deposit.logIndex}`)
  }
  const toTopic = topics[2]
  if (!toTopic || toTopic.length < 66) {
    refuse('deposit-mismatch', 'ARC_USDC_LOG: Transfer missing `to`')
  }
  const to = assertEthAddress(`0x${toTopic.slice(26)}`)
  const atomsBig = decodeUint256(log.data ?? '0x0')
  if (atomsBig <= 0n) refuse('deposit-mismatch', 'ARC_USDC_LOG: Transfer amount must be positive')
  const atoms = atomsBig.toString()
  if (deposit.atoms !== atoms) {
    refuse(
      'deposit-mismatch',
      `ARC_USDC_ATOMS: deposit claims ${deposit.atoms} atoms but log has ${atoms}`,
    )
  }
  return {
    atoms,
    to,
    tokenAddress: ARC_USDC_ERC20,
    log: {
      address: log.address ?? ARC_USDC_ERC20,
      topics: topics.filter((t): t is string => typeof t === 'string'),
      data: log.data ?? '0x0',
    },
  }
}

async function defaultVerifyDeposit(deposit: ArcUsdcDeposit): Promise<DepositSighting> {
  const plan = planFractionalize(deposit)
  const rpc = rpcOverride ?? createArcRpc(plan.network)
  const receipt = await rpc.call<{
    status?: string
    logs?: Array<{ address?: string; topics?: string[]; data?: string; logIndex?: number | string }>
  }>('eth_getTransactionReceipt', [deposit.txHash])
  if (!receipt || receipt.status !== '0x1') {
    refuse('deposit-mismatch', 'ARC_USDC_TX: deposit transaction is missing or failed')
  }
  const match = (receipt.logs ?? []).find((log) => {
    const idx = typeof log.logIndex === 'string' ? Number.parseInt(log.logIndex, 16) : Number(log.logIndex)
    return idx === deposit.logIndex
  })
  if (!match) refuse('deposit-mismatch', `ARC_USDC_LOG: no log at index ${deposit.logIndex}`)
  return sightingFromReceiptLog(deposit, match)
}

async function defaultPayout(args: {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  to: string
}): Promise<{ txHash: string }> {
  const { arcUsdWallet } = await import('./arcUsdWallet')
  const paid = await arcUsdWallet.send({ address: args.to, amount: args.atoms })
  return { txHash: paid.txid.startsWith('0x') ? paid.txid : `0x${paid.txid}` }
}

async function defaultMint(args: {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  deposit: { txHash: string; logIndex: number }
  reserveAddress: string
  proof: ArcReceiptProof
  existingAssetId: string | null
}): Promise<{ assetId: string; mintTxid: string; spendable: ArcUsdcAtoms }> {
  const { issueBntAsset, mintBntAsset, proveBntBacking, listBntAssets } = await import('../bnt/wallet')
  const deposit = arcDepositOutpoint(args.deposit.txHash, args.deposit.logIndex)
  const bk = { chain: 'arc' as const, reserve: arcReserveHex(args.reserveAddress) }
  let assetId: string
  let mintTxid: string
  if (!args.existingAssetId) {
    const issued = await issueBntAsset(
      { kind: 'token', sym: 'USDC', supply: args.atoms, dec: 6, auth: true },
      { backing: { deposit, bk } },
    )
    assetId = issued.assetId
    mintTxid = issued.txid
  } else {
    const minted = await mintBntAsset(
      { assetId: args.existingAssetId, amount: args.atoms },
      { backing: { deposit } },
    )
    assetId = args.existingAssetId
    mintTxid = minted.txid
  }
  await proveBntBacking(assetId, mintTxid, args.proof)
  const listed = await listBntAssets()
  const row = listed.assets.find((a) => a.assetId === assetId)
  const locked = BigInt(row?.locked ?? '0')
  const balance = BigInt(row?.balance ?? '0')
  return { assetId, mintTxid, spendable: (balance - locked).toString() }
}

async function defaultBurn(args: {
  assetId: string
  atoms: ArcUsdcAtoms
}): Promise<{ burnTxid: string; spendable: ArcUsdcAtoms }> {
  const { burnBntUnits, BNT_BURN_HOLDER, listBntAssets } = await import('../bnt/wallet')
  const burned = await burnBntUnits({
    assetId: args.assetId,
    amount: BigInt(args.atoms),
    holder: BNT_BURN_HOLDER,
    memo: 'arc usdc redeem',
  })
  const listed = await listBntAssets()
  const row = listed.assets.find((a) => a.assetId === args.assetId)
  const locked = BigInt(row?.locked ?? '0')
  const balance = BigInt(row?.balance ?? '0')
  return { burnTxid: burned.txid, spendable: (balance - locked).toString() }
}

/** Verify an Arc USDC deposit and mint BNT-backed units (1:1 atoms). */
export async function executeFractionalize(
  deposit: ArcUsdcDeposit,
  opts?: { verify?: VerifyArcDeposit; mint?: MintWrapUnits },
): Promise<WrapResult> {
  requireLab()
  const plan = planFractionalize(deposit)
  const id = depositClaimId(plan.network, plan.deposit.txHash, plan.deposit.logIndex)
  const store = readStore()
  if (store.claims[id]) {
    refuse('already-wrapped', `ARC_USDC_WRAP: deposit ${id} is already wrapped`)
  }

  const verify = opts?.verify ?? verifyOverride ?? defaultVerifyDeposit
  const sighting = await verify(deposit)
  if (sighting.atoms !== plan.deposit.atoms) {
    refuse(
      'deposit-mismatch',
      `ARC_USDC_ATOMS: verified ${sighting.atoms} ≠ planned ${plan.deposit.atoms}`,
    )
  }
  if (sighting.tokenAddress.toLowerCase() !== ARC_USDC_ERC20.toLowerCase()) {
    refuse('deposit-mismatch', 'ARC_USDC_TOKEN: verified token is not Arc USDC')
  }
  if (!reserveOverride) {
    const own = (await import('./arcUsdWallet')).arcUsdWallet.getAddress()
    if (sighting.to.toLowerCase() !== own.toLowerCase()) {
      refuse(
        'deposit-mismatch',
        `ARC_USDC_TO: Transfer to ${sighting.to} is not this wallet's Arc address ${own}`,
      )
    }
  } else if (sighting.to.toLowerCase() !== assertEthAddress(reserveOverride).toLowerCase()) {
    refuse(
      'deposit-mismatch',
      `ARC_USDC_TO: Transfer to ${sighting.to} is not the wrap reserve`,
    )
  }
  if (!sighting.log) {
    refuse('deposit-mismatch', 'ARC_USDC_LOG: verify did not return the Transfer log for the proof')
  }
  const proof = arcReceiptProofOf(plan.deposit, sighting.log)
  const reserveAddress = reserveOverride ? assertEthAddress(reserveOverride) : sighting.to

  const mint = opts?.mint ?? mintOverride ?? defaultMint
  let minted: { assetId: string; mintTxid: string; spendable: ArcUsdcAtoms }
  try {
    minted = await mint({
      network: plan.network,
      atoms: plan.deposit.atoms,
      deposit: plan.deposit,
      reserveAddress,
      proof,
      existingAssetId: store.assetId,
    })
  } catch (err) {
    if (err instanceof ArcWrapRefusalError) throw err
    refuse('mint-failed', err instanceof Error ? err.message : String(err))
  }

  const claim: WrapClaim = {
    id,
    network: plan.network,
    atoms: plan.deposit.atoms,
    deposit: { txHash: plan.deposit.txHash, logIndex: plan.deposit.logIndex },
    mintTxid: minted.mintTxid,
    assetId: minted.assetId,
    wrappedAt: Date.now(),
  }
  store.assetId = minted.assetId
  store.claims[id] = claim
  store.spendable = minted.spendable
  writeStore(store)
  return {
    claim,
    plan,
    assetId: minted.assetId,
    mintTxid: minted.mintTxid,
    spendable: minted.spendable,
    status: 'wrapped',
  }
}

/** Burn BNT-backed units and pay Arc USDC to `to`. */
export async function executeRedeem(
  args: { chainId: number; atoms: ArcUsdcAtoms; to: string },
  opts?: { payout?: PayoutArcUsdc; burn?: BurnWrapUnits },
): Promise<RedeemResult> {
  requireLab()
  const plan = planRedeem(args)
  const store = readStore()
  if (!store.assetId) {
    refuse('insufficient', 'ARC_USDC_WRAP: no wrapped USDC asset to redeem')
  }
  const available = BigInt(store.spendable)
  const need = BigInt(plan.atoms)
  if (available < need) {
    refuse(
      'insufficient',
      `ARC_USDC_WRAP: need ${plan.atoms} claim atoms, have ${available.toString()}`,
    )
  }

  const burn = opts?.burn ?? burnOverride ?? defaultBurn
  let burned: { burnTxid: string; spendable: ArcUsdcAtoms }
  try {
    burned = await burn({ assetId: store.assetId, atoms: plan.atoms })
  } catch (err) {
    if (err instanceof ArcWrapRefusalError) throw err
    refuse('burn-failed', err instanceof Error ? err.message : String(err))
  }

  // Persist burn before payout — BNT units are already gone (BRC-212 redeem order).
  let left = need
  const ordered = Object.values(store.claims)
    .filter((c) => c.network === plan.network)
    .sort((a, b) => a.wrappedAt - b.wrappedAt)
  for (const claim of ordered) {
    if (left <= 0n) break
    const have = BigInt(claim.atoms)
    if (have <= left) {
      delete store.claims[claim.id]
      left -= have
    } else {
      store.claims[claim.id] = { ...claim, atoms: (have - left).toString() }
      left = 0n
    }
  }
  store.spendable = burned.spendable
  writeStore(store)

  const payout = opts?.payout ?? payoutOverride ?? defaultPayout
  let paid: { txHash: string }
  try {
    paid = await payout({ network: plan.network, atoms: plan.atoms, to: plan.to })
  } catch (err) {
    if (err instanceof ArcWrapRefusalError) throw err
    refuse('payout-failed', err instanceof Error ? err.message : String(err))
  }
  if (typeof paid.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(paid.txHash)) {
    refuse('payout-failed', 'ARC_USDC_PAYOUT: payout must return 0x + 64 hex tx hash')
  }

  store.redeems.push({
    atoms: plan.atoms,
    to: plan.to,
    txHash: paid.txHash.toLowerCase(),
    burnTxid: burned.burnTxid,
    at: Date.now(),
    assetId: store.assetId,
    network: plan.network,
  })
  writeStore(store)
  return {
    network: plan.network,
    atoms: plan.atoms,
    to: plan.to,
    assetId: store.assetId,
    burnTxid: burned.burnTxid,
    redeemTxHash: paid.txHash.toLowerCase(),
    spendable: burned.spendable,
    status: 'redeemed',
  }
}

export function transferTopic0(): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode('Transfer(address,address,uint256)')))}`
}

export function encodeTransferLogData(atoms: bigint): string {
  return `0x${atoms.toString(16).padStart(64, '0')}`
}
