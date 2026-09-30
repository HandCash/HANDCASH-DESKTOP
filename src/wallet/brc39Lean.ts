/**
 * BRC-39 encrypt/decrypt that holds each copy of the document once.
 *
 * Byte-compatible with the toolbox's `encryptBRC39` / `decryptBRC39`: same
 * header, same Argon2id derivation (hash-wasm, the toolbox's own backend),
 * same AES-256-GCM with a 32-byte nonce and 16-byte tag. The toolbox versions
 * round-trip the document through `number[]` arrays several times — eight or
 * more bytes of heap per byte of backup — which an Android WebView cannot hold
 * for a history of tens of megabytes. Here the plaintext is one `Uint8Array`
 * and AES-GCM runs natively in WebCrypto.
 */
import {
  ARGON2ID_MAX_ITERATIONS,
  ARGON2ID_MAX_MEMORY_KIB,
  ARGON2ID_MAX_PARALLELISM,
  parseBRC38Json,
  type BRC38WalletData,
} from '@bsv/wallet-toolbox-client'
import { Utils } from '@bsv/sdk'
import { argon2id } from 'hash-wasm'

const MAGIC = [0x57, 0x44, 0x41, 0x54]
const HEADER_LENGTH = 33
const TAG_LENGTH = 16
const ITERATIONS = 7
const MEMORY_KIB = 131_072
const PARALLELISM = 1
const HASH_LENGTH = 32
const SALT_LENGTH = 32
const NONCE_LENGTH = 32

/** WebCrypto refused the AES-GCM parameters; the caller may use the toolbox path. */
export class Brc39LeanUnsupportedError extends Error {
  override readonly name = 'Brc39LeanUnsupportedError'
}

function wasmUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /webassembly.*(?:not supported|unavailable|disabled|compile|instantiate|module)/i.test(message)
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  memoryKiB: number,
  parallelism: number,
): Promise<CryptoKey> {
  const secret = new Uint8Array(Utils.toArray(password.normalize('NFC'), 'utf8'))
  let raw: Uint8Array
  try {
    raw = await argon2id({
      password: secret, salt, iterations, memorySize: memoryKiB, parallelism,
      hashLength: HASH_LENGTH, outputType: 'binary',
    })
  } catch (error) {
    if (!wasmUnavailable(error)) throw error
    const { argon2idAsync } = await import('@noble/hashes/argon2.js')
    raw = await argon2idAsync(secret, salt, {
      t: iterations, m: memoryKiB, p: parallelism, dkLen: HASH_LENGTH, asyncTick: 10,
    })
  }
  if (raw.length !== HASH_LENGTH) throw new Error('Invalid BRC-39 Argon2id output')
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function writeUInt32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 255
  target[offset + 1] = (value >>> 16) & 255
  target[offset + 2] = (value >>> 8) & 255
  target[offset + 3] = value & 255
}

function readUInt32BE(source: Uint8Array, offset: number): number {
  return ((source[offset]! << 24) >>> 0) + (source[offset + 1]! << 16) + (source[offset + 2]! << 8) + source[offset + 3]!
}

/** Encrypt a BRC-38 JSON document. The document is validated before sealing. */
export async function encryptBrc39Lean(json: string, password: string): Promise<Uint8Array<ArrayBuffer>> {
  parseBRC38Json(json)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
  const key = await deriveKey(password, salt, ITERATIONS, MEMORY_KIB, PARALLELISM)
  let sealed: ArrayBuffer
  try {
    sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
      key,
      new TextEncoder().encode(json),
    )
  } catch (error) {
    throw new Brc39LeanUnsupportedError(error instanceof Error ? error.message : String(error))
  }
  const out = new Uint8Array(HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + sealed.byteLength)
  out.set(MAGIC, 0)
  out[4] = 1
  out[5] = 1
  out[6] = 38
  out[7] = 1
  out[8] = 0
  out[9] = SALT_LENGTH
  out[10] = NONCE_LENGTH
  writeUInt32BE(out, 11, ITERATIONS)
  writeUInt32BE(out, 15, MEMORY_KIB)
  out[19] = PARALLELISM
  out[20] = HASH_LENGTH
  out.set(salt, HEADER_LENGTH)
  out.set(nonce, HEADER_LENGTH + SALT_LENGTH)
  out.set(new Uint8Array(sealed), HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH)
  return out
}

/** Decrypt and validate a BRC-39 file. Tampering or a wrong password fails authentication. */
export async function decryptBrc39Lean(bytes: Uint8Array, password: string): Promise<BRC38WalletData> {
  const file: Uint8Array<ArrayBuffer> = bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)
  if (file.length < 51) throw new Error('Invalid BRC-39 file: too short')
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (file[i] !== MAGIC[i]) throw new Error('Invalid BRC-39 file: bad magic')
  }
  if (file[4] !== 1 || file[5] !== 1 || file[6] !== 38 || file[7] !== 1 || file[8] !== 0) {
    throw new Error('Unsupported BRC-39 header')
  }
  for (let i = 21; i < HEADER_LENGTH; i += 1) {
    if (file[i] !== 0) throw new Error('Invalid BRC-39 reserved bytes')
  }
  const saltLength = file[9]!
  const nonceLength = file[10]!
  if (saltLength === 0) throw new Error('Invalid BRC-39 salt length')
  if (nonceLength === 0) throw new Error('Invalid BRC-39 nonce length')
  const iterations = readUInt32BE(file, 11)
  const memoryKiB = readUInt32BE(file, 15)
  const parallelism = file[19]!
  if (file[20] !== HASH_LENGTH) throw new Error('Invalid BRC-39 Argon2id hashLength')
  if (iterations <= 0 || iterations > ARGON2ID_MAX_ITERATIONS) throw new Error('Invalid BRC-39 Argon2id iterations')
  if (memoryKiB <= 0 || memoryKiB > ARGON2ID_MAX_MEMORY_KIB) throw new Error('Invalid BRC-39 Argon2id memoryKiB')
  if (parallelism <= 0 || parallelism > ARGON2ID_MAX_PARALLELISM) throw new Error('Invalid BRC-39 Argon2id parallelism')
  const payloadStart = HEADER_LENGTH + saltLength + nonceLength
  if (file.length <= payloadStart + TAG_LENGTH) throw new Error('Invalid BRC-39 ciphertext')
  const salt = file.slice(HEADER_LENGTH, HEADER_LENGTH + saltLength)
  const nonce = file.slice(HEADER_LENGTH + saltLength, payloadStart)
  const key = await deriveKey(password, salt, iterations, memoryKiB, parallelism)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
      key,
      file.subarray(payloadStart),
    )
  } catch {
    throw new Error('BRC-39 authentication failed')
  }
  return parseBRC38Json(new TextDecoder().decode(plaintext))
}
