/**
 * Device approval shared by sign-in and BRC-250.
 *
 * The new device commits to its one-time key and rA before the approving device
 * picks rB, and reveals rA only once. A relay that swaps in its own key would
 * have to have fixed its own rA before seeing rB, so the two screens show
 * different codes.
 */
import { Hash, PrivateKey, PublicKey, Utils } from '@bsv/sdk'

export function freshLoginKey(): PrivateKey {
  return PrivateKey.fromRandom()
}

export function randomHex(bytes: number): string {
  return Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(bytes))))
}

export function commitmentFor(loginKey: PublicKey, rA: string): string {
  return Utils.toHex(
    Hash.sha256(
      Utils.toArray(
        `brc250-commit\n${loginKey.toString().toLowerCase()}\n${rA}`,
        'utf8',
      ),
    ),
  )
}

export function comparisonCode(binding: string, rA: string, rB: string): string {
  const digest = Hash.sha256(
    Utils.toArray(`brc250-code\n${binding}\n${rA}\n${rB}`, 'utf8'),
  )
  let n = 0n
  for (const byte of digest.slice(0, 8)) n = (n << 8n) | BigInt(byte)
  return (n % 100_000_000n).toString().padStart(8, '0')
}

export type ApprovalReveal = {
  binding: string
  loginKey: string
  commitment: string
  rA: string | null
}

/** The approving device's code, only once the reveal matches the commitment. */
export function approvalComparisonCode(request: ApprovalReveal, rB: string): string {
  if (!request.rA) throw new Error('The new device has not revealed its code')
  if (
    commitmentFor(PublicKey.fromString(request.loginKey), request.rA) !==
    request.commitment.toLowerCase()
  ) {
    throw new Error('The new device reveal does not match its signed-in request')
  }
  return comparisonCode(request.binding, request.rA, rB)
}

/** Two halves on both screens: "1234 5678", "123 456". */
export function formatComparisonCode(code: string): string {
  const half = Math.ceil(code.length / 2)
  return `${code.slice(0, half)} ${code.slice(half)}`
}
