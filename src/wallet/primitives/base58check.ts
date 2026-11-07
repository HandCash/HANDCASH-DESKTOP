import { sha256d } from './hashes'
import { concatBytes } from '@noble/hashes/utils.js'

// Positional base conversion and leading zeroes; no SDK encoding implementation.
// Checksums delegate to MIT noble. Address-only input bound prevents unbounded work.
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function toBase58Check(data: number[], prefix: number[] = [0]): string {
  const payload = Uint8Array.from([...prefix, ...data])
  const bytes = concatBytes(payload, sha256d(payload).subarray(0, 4))
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let text = ''
  while (n) { text = alphabet[Number(n % 58n)] + text; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; text = '1' + text }
  return text
}

export function fromBase58Check(text: string): { prefix: number[]; data: number[] } {
  if (!text || text.length > 128) throw new Error('Invalid base58 address')
  let n = 0n
  for (const c of text) {
    const digit = alphabet.indexOf(c)
    if (digit < 0) throw new Error('Invalid base58 character')
    n = n * 58n + BigInt(digit)
  }
  const tail: number[] = []
  while (n) { tail.unshift(Number(n & 255n)); n >>= 8n }
  const bytes: number[] = []
  for (const c of text) { if (c !== '1') break; bytes.push(0) }
  bytes.push(...tail)
  if (bytes.length < 5) throw new Error('Truncated base58 checksum')
  const payload = Uint8Array.from(bytes.slice(0, -4))
  const checksum = sha256d(payload)
  if (!bytes.slice(-4).every((b, i) => b === checksum[i])) throw new Error('Invalid base58 checksum')
  return { prefix: [payload[0]!], data: Array.from(payload.subarray(1)) }
}
