/**
 * Node globals the Vite WebView does not provide but some SDK / bitcore paths
 * still touch. Pair with Vite aliases for `events` + `buffer`.
 */
import { Buffer } from 'buffer'

type ShimProcess = {
  env: Record<string, string | undefined>
  browser: boolean
  version: string
  versions: { node: string }
  platform: string
  title: string
  argv: string[]
  pid: number
  cwd: () => string
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void
  stdout?: { isTTY?: boolean }
  stderr?: { isTTY?: boolean }
}

const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  process?: ShimProcess
}

if (!g.Buffer) g.Buffer = Buffer

function nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
  queueMicrotask(() => fn(...args))
}

const shim: ShimProcess = {
  env: {
    NETWORK: '',
    BASEURL: '',
    NODE_ENV: 'production',
  },
  browser: true,
  version: 'v18.0.0',
  versions: { node: '18.0.0' },
  platform: 'browser',
  title: 'browser',
  argv: [],
  pid: 0,
  cwd: () => '/',
  nextTick,
  stdout: { isTTY: false },
  stderr: { isTTY: false },
}

// Cast through unknown so @types/node's Process does not fight the browser shim.
const existing = g.process as ShimProcess | undefined
if (!existing || typeof existing !== 'object') {
  ;(g as { process: ShimProcess }).process = shim
} else {
  const env = { ...shim.env, ...(existing.env ?? {}) }
  existing.env = env
  if (existing.env.NETWORK === undefined) existing.env.NETWORK = ''
  if (existing.env.BASEURL === undefined) existing.env.BASEURL = ''
  if (existing.env.NODE_ENV === undefined) existing.env.NODE_ENV = 'production'
  if (typeof existing.cwd !== 'function') existing.cwd = shim.cwd
  if (typeof existing.nextTick !== 'function') existing.nextTick = shim.nextTick
  if (existing.browser == null) existing.browser = true
  if (!existing.version) existing.version = shim.version
  if (!existing.versions) existing.versions = { node: '18.0.0' }
  if (!existing.platform) existing.platform = shim.platform
  if (!existing.title) existing.title = shim.title
  if (!existing.argv) existing.argv = shim.argv
  if (existing.pid == null) existing.pid = 0
}
