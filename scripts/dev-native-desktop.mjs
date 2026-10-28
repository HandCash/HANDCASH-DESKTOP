#!/usr/bin/env node
/**
 * Thin Win/Linux shell (native-desktop / wry) against Vite on :5173.
 * Called from dev-native.mjs on win32/linux, or directly via npm run dev:native-desktop.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const crate = path.join(root, 'native-desktop')
const pageJs = path.join(crate, 'handcash-page.js')

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
            socket.end()
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
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function ensureSidecar() {
  const sidecarJs = path.join(root, 'dist-sidecar/bridgeSidecar.cjs')
  const legacySidecar = path.join(root, 'dist-electron/bridgeSidecar.js')
  if (!fs.existsSync(sidecarJs)) {
    console.log('[dev:native-desktop] building sidecar…')
    await run('npm', ['run', 'build:sidecar'])
  }
  if (fs.existsSync(sidecarJs)) return sidecarJs
  if (fs.existsSync(legacySidecar)) return legacySidecar
  throw new Error(`missing ${sidecarJs} after build:sidecar`)
}

if (process.platform !== 'win32' && process.platform !== 'linux') {
  console.error(
    `[dev:native-desktop] this script is for win32/linux (got ${process.platform}); use npm run dev:native on macOS`,
  )
  process.exit(1)
}

await waitTcp(5173)
const sidecarPath = await ensureSidecar()

const binName = process.platform === 'win32' ? 'handcash-shell.exe' : 'handcash-shell'
const outBin = path.join(crate, 'target', 'debug', binName)
const cargoEnv = {
  ...process.env,
  // Keep the binary in-tree; Cursor sandboxes otherwise redirect CARGO_TARGET_DIR.
  CARGO_TARGET_DIR: path.join(crate, 'target'),
}
if (!fs.existsSync(outBin)) {
  console.log('[dev:native-desktop] cargo build (native-desktop)…')
  await run('cargo', ['build', '--manifest-path', path.join(crate, 'Cargo.toml')], {
    cwd: crate,
    env: cargoEnv,
  })
} else {
  console.log('[dev:native-desktop] using existing binary (set HANDCASH_FORCE_CARGO=1 to rebuild)')
  if (process.env.HANDCASH_FORCE_CARGO === '1') {
    console.log('[dev:native-desktop] cargo build (forced)…')
    await run('cargo', ['build', '--manifest-path', path.join(crate, 'Cargo.toml')], {
      cwd: crate,
      env: cargoEnv,
    })
  }
}
if (!fs.existsSync(outBin)) {
  throw new Error(`missing ${outBin} after cargo build`)
}
const st = fs.statSync(outBin)
console.log(`[dev:native-desktop] binary ${(st.size / 1024).toFixed(0)} KB → ${outBin}`)
console.log('[dev:native-desktop] launching (sidecar', sidecarPath, ')')

await run(outBin, [], {
  env: {
    ...process.env,
    HANDCASH_SHELL_PAGE_JS: pageJs,
    HANDCASH_BRIDGE_SIDECAR: sidecarPath,
    HANDCASH_NODE: process.execPath,
    HANDCASH_APP_VERSION: JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).version,
    HANDCASH_UI_ORIGIN: process.env.HANDCASH_UI_ORIGIN || 'http://localhost:5173',
  },
})
