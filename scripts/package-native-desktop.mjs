#!/usr/bin/env node
/**
 * Package HandCash Desktop as a thin Win/Linux folder (no Electron).
 * Layout: release/<platform>/HandCash/{handcash-shell, node, *.cjs, app/, handcash-page.js, start script}
 *
 * Stub (explicit): does not yet produce NSIS / AppImage / .deb installers — zip only.
 * Money-moving paths stay in the Node sidecar; never silently dropped.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
    shell: opts.shell ?? false,
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

console.log('==> build:sidecar')
run('npm', ['run', 'build:sidecar'])

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

copyFile(path.join(root, 'dist-sidecar/bridgeSidecar.cjs'), path.join(outDir, 'bridgeSidecar.cjs'))
copyFile(path.join(root, 'dist-sidecar/uiSidecar.cjs'), path.join(outDir, 'uiSidecar.cjs'))
for (const map of ['bridgeSidecar.cjs.map', 'uiSidecar.cjs.map']) {
  const src = path.join(root, 'dist-sidecar', map)
  if (fs.existsSync(src)) copyFile(src, path.join(outDir, map))
}
copyFile(path.join(crate, 'handcash-page.js'), path.join(outDir, 'handcash-page.js'))
copyDir(path.join(root, 'dist'), path.join(outDir, 'app'))

const nodeSrc = process.execPath
const nodeDest = path.join(outDir, target === 'win' ? 'node.exe' : 'node')
copyFile(nodeSrc, nodeDest)
if (target !== 'win') fs.chmodSync(nodeDest, 0o755)

if (target === 'win') {
  const cmd = `@echo off
setlocal
set "DIR=%~dp0"
set "HANDCASH_UI_ROOT=%DIR%app"
set "HANDCASH_BRIDGE_SIDECAR=%DIR%bridgeSidecar.cjs"
set "HANDCASH_NODE=%DIR%node.exe"
set "HANDCASH_SHELL_PAGE_JS=%DIR%handcash-page.js"
set "HANDCASH_UI_ORIGIN=http://localhost:5173"
set "HANDCASH_APP_VERSION=${version}"
start "HandCash UI" /b "%HANDCASH_NODE%" "%DIR%uiSidecar.cjs"
"%DIR%${binName}"
`
  fs.writeFileSync(path.join(outDir, 'HandCash.cmd'), cmd)
} else {
  const sh = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export HANDCASH_UI_ROOT="$DIR/app"
export HANDCASH_BRIDGE_SIDECAR="$DIR/bridgeSidecar.cjs"
export HANDCASH_NODE="$DIR/node"
export HANDCASH_SHELL_PAGE_JS="$DIR/handcash-page.js"
export HANDCASH_UI_ORIGIN=http://localhost:5173
export HANDCASH_APP_VERSION=${version}
"$HANDCASH_NODE" "$DIR/uiSidecar.cjs" &
UI_PID=$!
trap 'kill "$UI_PID" 2>/dev/null || true' EXIT
"$DIR/${binName}"
`
  const startPath = path.join(outDir, 'HandCash')
  fs.writeFileSync(startPath, sh)
  fs.chmodSync(startPath, 0o755)
}

fs.writeFileSync(
  path.join(outDir, 'STUBS.txt'),
  [
    `HandCash Desktop ${version} — thin native shell (${target}/${arch}).`,
    '',
    'Stub (explicit): no NSIS / AppImage / .deb yet — this zip is the ship artifact.',
    'Screen share / call recording / biometrics stay host stubs where noted in docs/thin-desktop-shell.md.',
    'BRC-100 + device-peer run in bridgeSidecar.cjs (Node); never silently dropped.',
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

console.log(`==> packaged ${zipPath}`)
console.log('    (installer formats stubbed — zip only; see STUBS.txt in the folder)')
