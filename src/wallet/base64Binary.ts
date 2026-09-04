/**
 * Shared base64 encode/decode for wallet binary payloads.
 *
 * Chunked `btoa` avoids call-stack / argument-limit failures on large BEEFs.
 */

const CHUNK = 0x8000

export function bytesToBase64(bytes: number[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
