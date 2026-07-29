import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { SetupClient, Wallet, sdk, type Services } from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'

const { specOpWalletBalance } = sdk

export type ActiveWallet = {
  /** Full toolbox wallet (has balance()). */
  wallet: Wallet
  services: Services
  rootKeyHex: string
  identityKey: string
  address: string
  handle: string
  chain: Chain
}

let active: ActiveWallet | null = null

export function getActiveWallet(): ActiveWallet | null {
  return active
}

export function clearActiveWallet(): void {
  active = null
}

export async function bootWallet(args: {
  rootKeyHex: string
  handle: string
  chain: Chain
}): Promise<ActiveWallet> {
  const root = PrivateKey.fromHex(args.rootKeyHex)
  const identityKey = root.toPublicKey().toString()
  const address = root.toAddress()

  const setup = await SetupClient.createWalletIdb({
    chain: args.chain,
    rootKeyHex: args.rootKeyHex,
    databaseName: `handcash-brc100-${args.chain}-${args.handle}`,
  })

  try {
    void setup.monitor?.startTasks?.()
  } catch {
    // optional
  }

  active = {
    wallet: setup.wallet,
    services: setup.services as Services,
    rootKeyHex: args.rootKeyHex,
    identityKey: setup.identityKey || identityKey,
    address,
    handle: args.handle,
    chain: args.chain,
  }
  return active
}

/** Prefer toolbox `Wallet.balance()` (BRC-100 change basket), with safe fallbacks. */
export async function fetchBalanceSats(wallet?: Wallet | WalletInterface): Promise<number> {
  const w = wallet ?? getActiveWallet()?.wallet
  if (!w) return 0
  const asToolbox = w as Wallet
  if (typeof asToolbox.balance === 'function') {
    try {
      const sats = await asToolbox.balance()
      if (Number.isFinite(sats)) return Math.max(0, Math.trunc(sats))
    } catch (err) {
      console.warn('[balance] Wallet.balance() failed', err)
    }
  }

  try {
    const result = await w.listOutputs({
      basket: specOpWalletBalance,
      limit: 1,
    })
    if (Number.isFinite(result.totalOutputs)) return Math.max(0, Math.trunc(result.totalOutputs))
  } catch (err) {
    console.warn('[balance] specOpWalletBalance failed', err)
  }

  try {
    const outputs = await w.listOutputs({
      basket: 'default',
      limit: 1000,
    })
    const sum = (outputs.outputs ?? []).reduce((s, o) => s + (o.satoshis ?? 0), 0)
    if (sum > 0) return sum
    if (Number.isFinite(outputs.totalOutputs)) return Math.max(0, Math.trunc(outputs.totalOutputs))
    return sum
  } catch (err) {
    console.warn('[balance] listOutputs default failed', err)
    return 0
  }
}

/** @deprecated use fetchBalanceSats */
export const estimateBalanceSats = fetchBalanceSats

/** Below this, amounts display as sats; at/above, as BSV. */
export const SATS_DISPLAY_THRESHOLD = 9999

/** Format satoshis for any UI amount: sats under 9999, otherwise BSV. */
export function formatBsv(sats: number): string {
  const safe = Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  if (safe < SATS_DISPLAY_THRESHOLD) {
    return `${safe.toLocaleString('en-US')} sats`
  }
  const bsv = safe / 1e8
  const formatted = bsv.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  })
  return `${formatted} BSV`
}

export function formatSats(sats: number): string {
  const safe = Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  return safe.toLocaleString('en-US')
}
