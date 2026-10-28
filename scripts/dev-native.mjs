#!/usr/bin/env node
/**
 * Thin native shell against the existing Vite UI on :5173.
 * - darwin → Mac Swift host below
 * - win32 / linux → scripts/dev-native-desktop.mjs
 * Pattern: docs/thin-desktop-shell.md
 *
 * Uses `swiftc` (not `swift build`): CommandLineTools SwiftPM can be broken
 * against a newer default SDK; we pick the newest MacOSX*.sdk the compiler accepts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32' || process.platform === 'linux') {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-native-desktop.mjs')
  const r = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: process.env,
  })
  process.exit(r.status ?? 1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = path.join(root, 'native-macos')
const sourcesDir = path.join(shellDir, 'Sources/HandCashShell')
const outDir = path.join(shellDir, '.build/debug')
const outBin = path.join(outDir, 'HandCashShell')
const pageJs = path.join(sourcesDir, 'handcash-page.js')

function waitTcp(port, hosts = ['127.0.0.1', '::1'], ms = 60_000) {
  const start = Date.now()
  const list = Array.isArray(hosts) ? hosts : [hosts]
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      let pending = list.length
      let opened = false
      for (const host of list) {
        const socket = createConnection({ port, host }, () => {
          if (opened) {
            socket.destroy()
            return
          }
          opened = true
          socket.end()
          resolve()
        })
        socket.on('error', () => {
          socket.destroy()
          pending -= 1
          if (opened) return
          if (pending > 0) return
          if (Date.now() - start > ms) {
            reject(
              new Error(
                `timed out waiting for ${list.join('|')}:${port} (start Vite with npm run dev:vite)`,
              ),
            )
            return
          }
          setTimeout(tryOnce, 250)
        })
      }
    }
    tryOnce()
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: opts.cwd ?? root,
      env: opts.env,
      shell: false,
    })
    const onTerm = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    }
    const onInt = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGINT')
    }
    if (opts.forwardSignals) {
      process.once('SIGTERM', onTerm)
      process.once('SIGINT', onInt)
    }
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (opts.forwardSignals) {
        process.off('SIGTERM', onTerm)
        process.off('SIGINT', onInt)
      }
      if (opts.forwardSignals && (signal === 'SIGTERM' || signal === 'SIGINT')) resolve()
      else if (opts.forwardSignals && (code === 143 || code === 130)) resolve()
      else if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

/** Prefer an SDK whose Swift interface matches this `swiftc` (avoid MacOSX26+ on Swift 6.1). */
function pickSdk() {
  const sdkRoot = '/Library/Developer/CommandLineTools/SDKs'
  if (!fs.existsSync(sdkRoot)) {
    const fallback = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' })
    if (fallback.status === 0) return fallback.stdout.trim()
    throw new Error('no CommandLineTools SDKs and xcrun --show-sdk-path failed')
  }
  const names = fs
    .readdirSync(sdkRoot)
    .filter((n) => /^MacOSX\d.*\.sdk$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  // Newest first, but skip 26+ when the compiler is older than the SDK.
  const preferred = [...names].reverse().filter((n) => !/^MacOSX26/.test(n))
  const candidates = preferred.length ? preferred : [...names].reverse()
  for (const name of candidates) {
    const sdk = path.join(sdkRoot, name)
    if (fs.existsSync(path.join(sdk, 'System/Library/Frameworks/WebKit.framework'))) {
      return sdk
    }
  }
  throw new Error(`no usable MacOSX SDK under ${sdkRoot}`)
}

function swiftSources() {
  return fs
    .readdirSync(sourcesDir)
    .filter((n) => n.endsWith('.swift'))
    .map((n) => path.join(sourcesDir, n))
    .sort()
}

await waitTcp(5173)

const sidecarJs = path.join(root, 'dist-sidecar/bridgeSidecar.cjs')
const legacySidecar = path.join(root, 'dist-electron/bridgeSidecar.js')
if (!fs.existsSync(sidecarJs)) {
  console.log('[dev:native] building sidecar…')
  await run('npm', ['run', 'build:sidecar'])
}
const sidecarPath = fs.existsSync(sidecarJs)
  ? sidecarJs
  : fs.existsSync(legacySidecar)
    ? legacySidecar
    : null
if (!sidecarPath) {
  throw new Error(`missing ${sidecarJs} after build:sidecar`)
}

fs.mkdirSync(outDir, { recursive: true })
const sdk = pickSdk()
console.log('[dev:native] sdk', sdk)
console.log('[dev:native] building HandCashShell…')
await run('swiftc', [
  '-o',
  outBin,
  '-sdk',
  sdk,
  '-target',
  'arm64-apple-macosx13.0',
  '-F',
  path.join(sdk, 'System/Library/Frameworks'),
  '-framework',
  'AppKit',
  '-framework',
  'WebKit',
  '-framework',
  'LocalAuthentication',
  '-framework',
  'Security',
  ...swiftSources(),
])

const st = fs.statSync(outBin)
console.log(`[dev:native] binary ${(st.size / 1024).toFixed(0)} KB → ${outBin}`)
console.log('[dev:native] launching (UI http://localhost:5173, sidecar', sidecarPath, ')')
await run(outBin, [], {
  forwardSignals: true,
  env: {
    ...process.env,
    HANDCASH_SHELL_PAGE_JS: pageJs,
    HANDCASH_BRIDGE_SIDECAR: sidecarPath,
    HANDCASH_NODE: process.execPath,
    HANDCASH_APP_VERSION: JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).version,
  },
})
