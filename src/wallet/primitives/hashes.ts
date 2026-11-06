import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'

// Algorithm compositions only; implementations come from MIT-licensed noble.
// Provenance and independent verification: docs/restricted-component-replacement.md.
export const sha256d = (bytes: Uint8Array): Uint8Array => sha256(sha256(bytes))
export const hash160 = (bytes: Uint8Array): Uint8Array => ripemd160(sha256(bytes))
