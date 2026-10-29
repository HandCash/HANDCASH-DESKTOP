/**
 * Sign a legacy EIP-155 transaction for Arc.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { signAsync } from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from './address'
import { rlpEncode, rlpUint } from './rlp'

export type LegacyTx = {
  nonce: number
  gasPrice: bigint
  gasLimit: bigint
  to: string
  value: bigint
  data: Uint8Array
  chainId: number
}

export async function signLegacyTx(tx: LegacyTx, privateKeyHex: string): Promise<string> {
  const key = normalizeKey(privateKeyHex)
  const unsigned = rlpEncode([
    rlpUint(tx.nonce),
    rlpUint(tx.gasPrice),
    rlpUint(tx.gasLimit),
    hexToBytes(tx.to),
    rlpUint(tx.value),
    tx.data,
    rlpUint(tx.chainId),
    new Uint8Array(),
    new Uint8Array(),
  ])
  const digest = keccak_256(unsigned)
  const sig = await signAsync(digest, key, { lowS: true })
  const compact = sig.toCompactRawBytes()
  const r = compact.subarray(0, 32)
  const s = compact.subarray(32, 64)
  const recovery = sig.recovery ?? 0
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(recovery)
  const raw = rlpEncode([
    rlpUint(tx.nonce),
    rlpUint(tx.gasPrice),
    rlpUint(tx.gasLimit),
    hexToBytes(tx.to),
    rlpUint(tx.value),
    tx.data,
    rlpUint(v),
    r,
    s,
  ])
  return `0x${bytesToHex(raw)}`
}

function normalizeKey(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{64}$/.test(body)) throw new Error('ARC_USD_KEY: need 32-byte hex private key')
  return hexToBytes(body)
}
