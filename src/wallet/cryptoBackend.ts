import {
  registerAsyncCryptoBackend,
  registerScriptVerificationBackend,
} from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'
import type { Chain } from './vault'

/**
 * libsecp256k1 + BSV BDK script engine in WebAssembly (`@bsv/verifast`).
 *
 * Constructing the verifier registers it as the SDK's page-wide optional
 * backend: P2PKH signing, BRC-42 derivation, and ProtoWallet signatures use it
 * once warm. Passed to the Toolbox as `scriptVerifier`, it also checks every
 * signed transaction's unlocking scripts before storage accepts it.
 *
 * Selection happens before execution. A cold or unloadable module keeps the
 * SDK's JavaScript path for that call; once WASM is selected its verdict is
 * authoritative and errors are never retried in JavaScript.
 */
const verifiers = new Map<Chain, BdkVerifier>()

export function walletCryptoBackend(chain: Chain): BdkVerifier | undefined {
  const existing = verifiers.get(chain)
  if (existing) {
    // The SDK holds one page-wide backend; the last chain booted owns it.
    registerAsyncCryptoBackend(existing)
    registerScriptVerificationBackend(existing)
    return existing
  }
  let verifier: BdkVerifier
  try {
    verifier = new BdkVerifier({ network: chain === 'test' ? 'test' : 'main' })
  } catch (err) {
    console.warn('[crypto] wasm backend refused; JavaScript crypto stays', err)
    return undefined
  }
  verifiers.set(chain, verifier)
  const started = performance.now()
  void verifier.preload().then(
    () => {
      console.info(
        `[crypto] wasm backend ready ${Math.round(performance.now() - started)}ms`,
      )
    },
    (err: unknown) => {
      console.warn('[crypto] wasm backend unavailable; JavaScript crypto stays', err)
    },
  )
  return verifier
}
