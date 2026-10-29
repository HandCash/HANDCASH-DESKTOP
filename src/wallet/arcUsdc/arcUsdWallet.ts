/**
 * Native USDC on Arc hold / send / receive (product surface mirrors BCH).
 *
 * Circle’s name is USDC; Arc is the chain. BRC-42 key under `[2, 'arc usd']`
 * (stable path — do not rename) → EIP-55 address. Balance and sends use the
 * Arc USDC ERC-20 view (6 decimals) over JSON-RPC. Not the UTXO `createCoinWallet`
 * engine — Arc is EVM, not Electrum/burial.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { assertOnlineForPayment } from '../paymentPolicy'
import type { ActiveWallet } from '../session'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { getWalletRuntime } from '../walletRuntime'
import { ethAddressFromPrivateKey, assertEthAddress, isEthAddress } from './address'
import { ARC_NETWORKS, ARC_USDC_DECIMALS, ARC_USDC_ERC20, type ArcNetwork } from './chain'
import {
  encodeTransfer,
  formatUsdcAtoms,
  readUsdcBalance,
  transferDataBytes,
  weiToAtoms,
} from './erc20'
import {
  createArcRpc,
  ethChainId,
  ethEstimateGas,
  ethGasPrice,
  ethGetTransactionCount,
  ethSendRawTransaction,
  type ArcRpc,
} from './rpc'
import { signLegacyTx } from './tx'

export const ARC_USD_DECIMALS = ARC_USDC_DECIMALS
/** Arc settles in under a second — same shape as BSV’s Instant, not UTXO confirmations. */
export const ARC_USD_PAYMENT_ETA = 'Instant'
export const ARC_USD_KEY_PROTOCOL: [2, string] = [2, 'arc usd']
export const ARC_USD_KEY_ID = '1'

const ATOMS = /^[1-9][0-9]*$/
const listeners = new Set<() => void>()

type ArcUsdStore = {
  /** Last known spendable atoms (6-dec), durable so first paint has a figure. */
  spendable: string
  updatedAt: number
}

export type SendArcUsdArgs = {
  address?: unknown
  /** 6-decimal atoms, as a positive integer string (same role as coin `litoshi`). */
  litoshi?: unknown
  amount?: unknown
  identityKey?: unknown
}

export type SendArcUsdResult = {
  txid: string
  amount: string
  fee: string
  status: 'sent'
}

export class ArcUsdRefusalError extends Error {
  constructor(
    readonly reason: 'bad-args' | 'own-address' | 'insufficient' | 'held-elsewhere' | 'unsupported-recipient',
    message: string,
  ) {
    super(message)
    this.name = 'ArcUsdRefusalError'
  }
}

let rpcOverride: ArcRpc | null = null
let network: ArcNetwork = 'arc-mainnet'
let watchTimer: ReturnType<typeof setInterval> | null = null

function storeKey(): string {
  return accountLocalKey(storageRegistry.arcUsd.key)
}

function readStore(): ArcUsdStore {
  try {
    const raw = durableGetItem(storeKey())
    if (!raw) return { spendable: '0', updatedAt: 0 }
    const parsed = JSON.parse(raw) as ArcUsdStore
    if (!parsed || typeof parsed.spendable !== 'string') return { spendable: '0', updatedAt: 0 }
    return { spendable: parsed.spendable, updatedAt: Number(parsed.updatedAt) || 0 }
  } catch {
    return { spendable: '0', updatedAt: 0 }
  }
}

function writeStore(next: ArcUsdStore): void {
  durableSetItem(storeKey(), JSON.stringify(next))
  for (const listener of listeners) listener()
}

function requireActive(): ActiveWallet {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('No wallet unlocked')
  return active
}

function rpc(): ArcRpc {
  return rpcOverride ?? createArcRpc(network)
}

export function arcUsdCoinKey(root: PrivateKey): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(ARC_USD_KEY_PROTOCOL, ARC_USD_KEY_ID, 'self')
}

function keyOf(active: ActiveWallet): { key: PrivateKey; address: string } {
  const key = arcUsdCoinKey(PrivateKey.fromHex(active.rootKeyHex))
  return { key, address: ethAddressFromPrivateKey(key) }
}

function atomsOf(args: SendArcUsdArgs): bigint {
  const raw = args.litoshi ?? args.amount
  if (typeof raw !== 'string' || !ATOMS.test(raw)) {
    throw new ArcUsdRefusalError('bad-args', 'USDC amount must be a positive integer of 6-decimal atoms')
  }
  return BigInt(raw)
}

function refuse(reason: ArcUsdRefusalError['reason'], message: string): never {
  throw new ArcUsdRefusalError(reason, message)
}

function getAddress(): string {
  const active = requireActive()
  return keyOf(active).address
}

function addressForApp(): { address: string; decimals: number; minConfirmations: number } {
  return { address: getAddress(), decimals: ARC_USD_DECIMALS, minConfirmations: 1 }
}

function readBalance(): { spendable: string; confirming: string } {
  if (!getWalletRuntime()?.instance) return { spendable: '0', confirming: '0' }
  return { spendable: readStore().spendable, confirming: '0' }
}

function ensureMigrated(): void {
  // No legacy record to migrate; presence keeps heldCoins / session start symmetrical with BCH.
}

function preflightSend(args: SendArcUsdArgs): void {
  const active = requireActive()
  const heldElsewhere = activeAccountSpendRefusal(active)
  if (heldElsewhere) refuse('held-elsewhere', heldElsewhere)
  if (args.identityKey != null && String(args.identityKey).trim() !== '') {
    refuse('unsupported-recipient', 'USDC on Arc pays a 0x address, not a HandCash identity.')
  }
  const atoms = atomsOf(args)
  if (!isEthAddress(args.address)) refuse('bad-args', 'USDC needs a 0x recipient address')
  const to = assertEthAddress(args.address)
  const { address: own } = keyOf(active)
  if (to.toLowerCase() === own.toLowerCase()) {
    refuse('own-address', "That is this wallet's own USDC address; sending to it only spends the network fee.")
  }
  const ready = BigInt(readStore().spendable)
  if (ready < atoms) {
    refuse(
      'insufficient',
      `This wallet can spend ${formatUsdcAtoms(ready)} USDC, less than ${formatUsdcAtoms(atoms)} USDC.`,
    )
  }
}

async function preflightRecipient(args: SendArcUsdArgs): Promise<void> {
  preflightSend(args)
}

async function refresh(): Promise<{ address: string; balance: { spendable: string; confirming: string } }> {
  const active = requireActive()
  const { address } = keyOf(active)
  const atoms = await readUsdcBalance(rpc(), address)
  writeStore({ spendable: atoms.toString(), updatedAt: Date.now() })
  return { address, balance: readBalance() }
}

async function send(args: SendArcUsdArgs, opts?: { toLabel?: string; origin?: string }): Promise<SendArcUsdResult> {
  assertOnlineForPayment()
  preflightSend(args)
  const active = requireActive()
  const atoms = atomsOf(args)
  const to = assertEthAddress(args.address)
  const { key, address: from } = keyOf(active)
  const client = rpc()
  const chainId = await ethChainId(client)
  if (chainId !== ARC_NETWORKS[network].chainId) {
    throw new Error(`ARC_USD_CHAIN: RPC chainId ${chainId} is not ${network} (${ARC_NETWORKS[network].chainId})`)
  }
  const dataHex = encodeTransfer(to, atoms)
  const data = transferDataBytes(to, atoms)
  const [nonce, gasPrice, estimated] = await Promise.all([
    ethGetTransactionCount(client, from),
    ethGasPrice(client),
    ethEstimateGas(client, { from, to: ARC_USDC_ERC20, data: dataHex }),
  ])
  const gasLimit = estimated + estimated / 5n // +20% headroom
  const feeWei = gasLimit * gasPrice
  const feeAtoms = weiToAtoms(feeWei) + (feeWei % 10n ** 12n === 0n ? 0n : 1n)
  const ready = BigInt(readStore().spendable)
  // Same USDC pool pays the ERC-20 amount and gas — leave room for the fee.
  if (ready < atoms + feeAtoms) {
    refuse(
      'insufficient',
      `Need ${formatUsdcAtoms(atoms + feeAtoms)} USDC including Arc fee (~${formatUsdcAtoms(feeAtoms)}), have ${formatUsdcAtoms(ready)}.`,
    )
  }
  const raw = await signLegacyTx(
    {
      nonce,
      gasPrice,
      gasLimit,
      to: ARC_USDC_ERC20,
      value: 0n,
      data,
      chainId,
    },
    key.toHex(),
  )
  const txid = await ethSendRawTransaction(client, raw)
  const nextSpendable = ready - atoms - feeAtoms
  writeStore({
    spendable: (nextSpendable > 0n ? nextSpendable : 0n).toString(),
    updatedAt: Date.now(),
  })
  recordAppActivity({
    origin: opts?.origin ?? WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: 0,
    method: 'arc-usd-send',
    txid,
    note: opts?.toLabel ? `To ${opts.toLabel} · ${formatUsdcAtoms(feeAtoms)} Arc fee` : `${formatUsdcAtoms(feeAtoms)} Arc fee`,
    item: {
      name: 'USDC',
      origin: 'arc-usd',
      amt: atoms.toString(),
      dec: ARC_USD_DECIMALS,
    },
  })
  void refresh().catch((err) => console.warn('[arc-usd] refresh after send failed', err))
  return { txid, amount: atoms.toString(), fee: feeAtoms.toString(), status: 'sent' }
}

function startWatcher(): void {
  if (watchTimer) return
  const tick = () => {
    if (!getWalletRuntime()?.instance) return
    void refresh().catch((err) => console.warn('[arc-usd] watch refresh failed', err))
  }
  tick()
  watchTimer = setInterval(tick, 60_000)
}

function stopWatcher(): void {
  if (!watchTimer) return
  clearInterval(watchTimer)
  watchTimer = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test / lab: inject RPC and network. */
export function setArcUsdRpcForTest(next: ArcRpc | null, net: ArcNetwork = 'arc-mainnet'): void {
  rpcOverride = next
  network = net
}

export const arcUsdWallet = {
  chain: 'arc-usd' as const,
  label: 'USDC',
  ticker: 'USDC',
  decimals: ARC_USD_DECIMALS,
  paymentEta: ARC_USD_PAYMENT_ETA,
  coinKey: arcUsdCoinKey,
  getAddress,
  addressForApp,
  readBalance,
  ensureMigrated,
  preflightSend,
  preflightRecipient,
  refresh,
  send,
  startWatcher,
  stopWatcher,
  subscribe,
  format: formatUsdcAtoms,
}

export type ArcUsdWallet = typeof arcUsdWallet
