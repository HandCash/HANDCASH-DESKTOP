/**
 * Arc USDC ERC-20 view helpers (6 decimals). Same pool as native gas (18-dec
 * wei): 1 atom = 10^12 wei.
 */
import { ARC_USDC_DECIMALS, ARC_USDC_ERC20 } from './chain'
import { assertEthAddress, bytesToHex, hexToBytes } from './address'
import { ethCall, type ArcRpc } from './rpc'

/** ERC-20 `transfer(address,uint256)` selector. */
export const TRANSFER_SELECTOR = 'a9059cbb'
/** ERC-20 `balanceOf(address)` selector. */
export const BALANCE_OF_SELECTOR = '70a08231'

const WEI_PER_ATOM = 10n ** BigInt(18 - ARC_USDC_DECIMALS)

export function encodeBalanceOf(owner: string): string {
  return `0x${BALANCE_OF_SELECTOR}${padAddress(owner)}`
}

export function encodeTransfer(to: string, atoms: bigint): string {
  if (atoms < 0n) throw new Error('ARC_USD_AMOUNT: negative')
  return `0x${TRANSFER_SELECTOR}${padAddress(to)}${padUint(atoms)}`
}

export function decodeUint256(hex: string): bigint {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!body) return 0n
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new Error('ARC_USD_RPC: bad uint256')
  return BigInt(`0x${body}`)
}

export async function readUsdcBalance(rpc: ArcRpc, owner: string): Promise<bigint> {
  const data = encodeBalanceOf(owner)
  const raw = await ethCall(rpc, ARC_USDC_ERC20, data, owner)
  return decodeUint256(raw)
}

/** Wei → 6-decimal USDC atoms (floor). */
export function weiToAtoms(wei: bigint): bigint {
  return wei / WEI_PER_ATOM
}

/** 6-decimal USDC atoms → wei. */
export function atomsToWei(atoms: bigint): bigint {
  return atoms * WEI_PER_ATOM
}

function padAddress(address: string): string {
  const a = assertEthAddress(address)
  return a.slice(2).toLowerCase().padStart(64, '0')
}

function padUint(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

export function transferDataBytes(to: string, atoms: bigint): Uint8Array {
  return hexToBytes(encodeTransfer(to, atoms))
}

export function formatUsdcAtoms(atoms: bigint): string {
  const scale = 10n ** BigInt(ARC_USDC_DECIMALS)
  const whole = atoms / scale
  const frac = (atoms % scale).toString().padStart(ARC_USDC_DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function parseUsdcAtoms(text: string): bigint {
  const t = text.trim()
  if (!t || !/^\d+(\.\d+)?$/.test(t)) throw new Error('ARC_USD_AMOUNT: need a decimal amount')
  const [whole, frac = ''] = t.split('.')
  if (frac.length > ARC_USDC_DECIMALS) throw new Error('ARC_USD_AMOUNT: at most 6 decimal places')
  const fracPad = frac.padEnd(ARC_USDC_DECIMALS, '0')
  return BigInt(whole!) * 10n ** BigInt(ARC_USDC_DECIMALS) + BigInt(fracPad || '0')
}

export { bytesToHex }
