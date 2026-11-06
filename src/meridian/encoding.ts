import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// M1 origins and limits: docs/meridian-engine.md. No legacy implementation import.
export const encodeHex = (bytes: Uint8Array): string => bytesToHex(bytes)

export function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Expected even-length hexadecimal')
  }
  return hexToBytes(hex)
}
