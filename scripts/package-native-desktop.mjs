#!/usr/bin/env node
/**
 * Package HandCash Desktop as a pure-Rust thin Win/Linux folder (no Electron, no Node runtime).
 * Layout: release/<platform>/HandCash/{handcash-shell, app/, handcash-page.js, start script}
 *
 * The Rust binary hosts the OS WebView, BRC-100 HTTP/HTTPS bridge (:3321/:2121),
 * LAN device-peer (:3340), durable keyring store, and packaged UI server (:5173).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

const target = (process.argv[2] || '').trim() || (process.platform === 'win32' ? 'win' : 'linux')
if (target !== 'win' && target !== 'linux') {
  console.error(`usage: package-native-desktop.mjs win|linux (got ${target})`)
  process.exit(1)
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const outName = target === 'win' ? `win-${arch}` : `linux-${arch}`
const outDir = path.join(root, 'release', outName, 'HandCash')
const crate = path.join(root, 'native-desktop')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: opts.env ?? process.env,
    // Windows npm is a .cmd shim and must be launched through cmd.exe.
    shell: opts.shell ?? (process.platform === 'win32' && cmd === 'npm'),
  })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name)
    const to = path.join(dest, name)
    if (fs.statSync(from).isDirectory()) copyDir(from, to)
    else copyFile(from, to)
  }
}

if (process.platform === 'darwin' && !process.env.HANDCASH_ALLOW_CROSS) {
  console.warn(
    `[package-native-desktop] building ${target} artifacts on darwin — cargo may need a cross target; set HANDCASH_ALLOW_CROSS=1 to silence.`,
  )
}

if (process.env.HANDCASH_SKIP_RENDERER !== '1') {
  console.log('==> build:renderer')
  run('npm', ['run', 'build:renderer'])
}

// Keep artifacts in-tree (Cursor sandboxes otherwise redirect CARGO_TARGET_DIR).
const cargoTargetDir = path.join(crate, 'target')
console.log('==> cargo build --release (native-desktop)')
run('cargo', ['build', '--release'], {
  cwd: crate,
  env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
})

const binName = target === 'win' ? 'handcash-shell.exe' : 'handcash-shell'
const binSrc = path.join(cargoTargetDir, 'release', binName)
if (!fs.existsSync(binSrc)) {
  throw new Error(`missing ${binSrc} — build on ${target} (or install the Rust target)`)
}

rimraf(outDir)
fs.mkdirSync(outDir, { recursive: true })

copyFile(binSrc, path.join(outDir, binName))
if (target !== 'win') fs.chmodSync(path.join(outDir, binName), 0o755)

copyFile(path.join(crate, 'handcash-page.js'), path.join(outDir, 'handcash-page.js'))
copyDir(path.join(root, 'dist'), path.join(outDir, 'app'))

if (target === 'win') {
  const cmd = `@echo off
setlocal
set "DIR=%~dp0"
set "HANDCASH_UI_ROOT=%DIR%app"
set "HANDCASH_SHELL_PAGE_JS=%DIR%handcash-page.js"
set "HANDCASH_UI_ORIGIN=http://localhost:5173"
set "HANDCASH_APP_VERSION=${version}"
"%DIR%${binName}" %*
`
  fs.writeFileSync(path.join(outDir, 'HandCash.cmd'), cmd)
} else {
  const sh = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export HANDCASH_UI_ROOT="$DIR/app"
export HANDCASH_SHELL_PAGE_JS="$DIR/handcash-page.js"
export HANDCASH_UI_ORIGIN=http://localhost:5173
export HANDCASH_APP_VERSION=${version}
exec "$DIR/${binName}" "$@"
`
  const startPath = path.join(outDir, 'HandCash')
  fs.writeFileSync(startPath, sh)
  fs.chmodSync(startPath, 0o755)
}

fs.writeFileSync(
  path.join(outDir, 'STUBS.txt'),
  [
    `HandCash Desktop ${version} — pure-Rust native shell (${target}/${arch}, zero Electron, zero Node).`,
    '',
    'Implemented natively in handcash-shell (Rust):',
    '  - BRC-100 HTTP (:3321) + HTTPS (:2121, rustls + self-signed localhost cert) on 127.0.0.1 and [::1]',
    '  - LAN device-peer HTTP server (0.0.0.0:3340) with origin allowlist',
    '  - Built-in packaged UI static server (http://localhost:5173)',
    '  - Durable file store + OS keyring AES-GCM vault seal (sealed:native:v1:)',
    '  - Embedded app-browser guests (isolated child WebViews)',
    '  - Save dialogs (verified atomic backups + images) & file chooser',
    '  - Text + image clipboard and in-app screenshot capture (Linux)',
    '  - Append-only local BRC-39 UTXO archive & sealed on-device call recordings',
    '  - Rotating host logs (getLogInfo / readLogs / openLogs) & live Omarchy theme watcher',
    '  - Bounded GitHub release checks in Rust; portable zip downloads open in the browser',
    '',
    'Platform notes:',
    '  - Shipped as a portable zip (no NSIS / AppImage / .deb installer wrapper yet).',
    '  - Screen share picker and OS biometric unlock remain unavailable on Linux/Windows (matching Electron).',
    '',
  ].join('\n'),
)

const releaseRoot = path.join(root, 'release')
fs.mkdirSync(releaseRoot, { recursive: true })
const zipName =
  target === 'win'
    ? `HandCash-${version}-${arch}-win.zip`
    : `HandCash-${version}-${arch}-linux.zip`
const zipPath = path.join(releaseRoot, zipName)
rimraf(zipPath)

if (process.platform === 'win32') {
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${outDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ])
} else {
  run('zip', ['-r', zipPath, path.basename(outDir)], {
    cwd: path.dirname(outDir),
  })
}

console.log(`==> packaged ${zipPath} (pure Rust, zero Node runtime)`)

// Generate SHA256 checksum for verification
const crypto = await import('node:crypto')
const zipContent = fs.readFileSync(zipPath)
const hash = crypto.createHash('sha256').update(zipContent).digest('hex')
const checksumPath = zipPath + '.sha256'
fs.writeFileSync(checksumPath, `${hash}  ${path.basename(zipPath)}\n`)
console.log(`==> checksum ${checksumPath}`)
