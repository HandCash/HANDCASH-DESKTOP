/**
 * Arc receipt binding for BNT-backed USDC wrap (BRC-212 shape, EVM proof).
 *
 * Deposit outpoint in `bntb`: txid = Arc tx hash (32 bytes, no 0x), vout = logIndex.
 * Reserve in `bk`: 20-byte Eth address hex (no 0x) — the wallet's Arc USDC address.
 * Proof: successful Transfer of Arc USDC to that reserve for ≥ minted atoms.
 *
 * Peer-checkable custody evidence, not PoW SPV burial. Instant finality: a
 * successful receipt is enough to make units movable.
 */
import type { BackingCheck, BackingOutpoint } from '../bnt/backing'
import { assertEthAddress } from './address'
import { ARC_USDC_ERC20 } from './chain'
import { decodeUint256 } from './erc20'

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export type ArcReceiptProof = {
  kind: 'arc-receipt'
  /** Arc tx hash, 0x + 64 hex. */
  txHash: string
  logIndex: number
  /** Receipt status; must be 0x1. */
  status: string
  log: {
    address: string
    topics: string[]
    data: string
  }
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

export function isArcReceiptProof(value: unknown): value is ArcReceiptProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.kind !== 'arc-receipt') return false
  if (typeof v.txHash !== 'string' || !TX_HASH.test(v.txHash)) return false
  if (!Number.isInteger(v.logIndex) || (v.logIndex as number) < 0) return false
  if (typeof v.status !== 'string') return false
  if (!v.log || typeof v.log !== 'object' || Array.isArray(v.log)) return false
  const log = v.log as Record<string, unknown>
  return (
    typeof log.address === 'string' &&
    Array.isArray(log.topics) &&
    log.topics.every((t) => typeof t === 'string') &&
    typeof log.data === 'string'
  )
}

export function readArcReceiptProof(value: unknown): ArcReceiptProof | null {
  if (!isArcReceiptProof(value)) return null
  return {
    kind: 'arc-receipt',
    txHash: value.txHash.toLowerCase(),
    logIndex: value.logIndex,
    status: value.status.toLowerCase(),
    log: {
      address: value.log.address,
      topics: [...value.log.topics],
      data: value.log.data,
    },
  }
}

/** Arc deposit as BNT `bntb` outpoint: tx hash bytes + logIndex as vout. */
export function arcDepositOutpoint(txHash: string, logIndex: number): BackingOutpoint {
  if (!TX_HASH.test(txHash)) throw new Error('ARC_USDC_TX: deposit txHash must be 0x + 64 hex')
  if (!Number.isInteger(logIndex) || logIndex < 0 || logIndex > 0xffffffff) {
    throw new Error('ARC_USDC_LOG: logIndex must fit a u32')
  }
  return { txid: txHash.slice(2).toLowerCase(), vout: logIndex }
}

/** `bk.reserve` for Arc: 20-byte address hex without 0x. */
export function arcReserveHex(address: string): string {
  return assertEthAddress(address).slice(2).toLowerCase()
}

export function padAddressTopic(address: string): string {
  const a = assertEthAddress(address).slice(2).toLowerCase()
  return `0x${'0'.repeat(24)}${a}`
}

/**
 * Check that `proof` shows Arc USDC Transfer to `bk.reserve` for ≥ `minted`
 * atoms, naming the same deposit outpoint.
 */
export function checkArcReceiptProof(
  reserveHex: string,
  proof: ArcReceiptProof,
  deposit: BackingOutpoint,
  minted: bigint,
): BackingCheck {
  if (proof.status !== '0x1') {
    return { ok: false, detail: 'ARC_USDC_TX: receipt status is not success', missing: false }
  }
  const wantTx = deposit.txid.toLowerCase()
  const gotTx = proof.txHash.slice(2).toLowerCase()
  if (gotTx !== wantTx) {
    return { ok: false, detail: `ARC_USDC_TX: proof tx ${gotTx} ≠ deposit ${wantTx}`, missing: false }
  }
  if (proof.logIndex !== deposit.vout) {
    return {
      ok: false,
      detail: `ARC_USDC_LOG: proof logIndex ${proof.logIndex} ≠ deposit vout ${deposit.vout}`,
      missing: false,
    }
  }
  const topics = proof.log.topics
  if ((topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC) {
    return { ok: false, detail: 'ARC_USDC_LOG: expected Transfer topic0', missing: false }
  }
  if ((proof.log.address ?? '').toLowerCase() !== ARC_USDC_ERC20.toLowerCase()) {
    return { ok: false, detail: 'ARC_USDC_TOKEN: log is not Arc USDC', missing: false }
  }
  const toTopic = topics[2]
  if (!toTopic || toTopic.length < 66) {
    return { ok: false, detail: 'ARC_USDC_LOG: Transfer missing `to`', missing: false }
  }
  const toHex = toTopic.slice(26).toLowerCase()
  if (toHex !== reserveHex.toLowerCase()) {
    return {
      ok: false,
      detail: `ARC_USDC_TO: Transfer to ${toHex} ≠ reserve ${reserveHex.toLowerCase()}`,
      missing: false,
    }
  }
  let atoms: bigint
  try {
    atoms = decodeUint256(proof.log.data ?? '0x0')
  } catch {
    return { ok: false, detail: 'ARC_USDC_ATOMS: Transfer data is not a uint256', missing: false }
  }
  if (atoms < minted) {
    return {
      ok: false,
      detail: `ARC_USDC_ATOMS: Transfer ${atoms.toString()} < minted ${minted.toString()}`,
      missing: false,
    }
  }
  return { ok: true }
}

/** Build a package-ready Arc proof from a verified Transfer log. */
export function arcReceiptProofOf(
  deposit: { txHash: string; logIndex: number },
  log: { address: string; topics: string[]; data: string },
): ArcReceiptProof {
  return {
    kind: 'arc-receipt',
    txHash: deposit.txHash.toLowerCase(),
    logIndex: deposit.logIndex,
    status: '0x1',
    log: {
      address: log.address,
      topics: [...log.topics],
      data: log.data,
    },
  }
}
