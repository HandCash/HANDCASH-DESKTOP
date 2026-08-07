/**
 * Node globals the Vite WebView does not provide but scrypt-ts / bitcore still
 * touch during hardened BRC-156 signing. Without these, covenant sends throw
 * and fall through to soft-latch / BRC-150.
 */
import { Buffer } from 'buffer'

type ShimProcess = { env: Record<string, string | undefined> }

const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  process?: ShimProcess
}

if (!g.Buffer) g.Buffer = Buffer

if (!g.process || typeof g.process !== 'object') {
  ;(g as { process: ShimProcess }).process = { env: {} }
}
const env = ((g.process as ShimProcess).env ??= {})
if (env.NETWORK === undefined) env.NETWORK = ''
if (env.BASEURL === undefined) env.BASEURL = ''
if (env.NODE_ENV === undefined) env.NODE_ENV = 'production'
