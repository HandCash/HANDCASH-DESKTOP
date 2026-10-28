#!/usr/bin/env node
/**
 * Package HandCash Desktop as a thin Mac .app (no Electron).
 * Layout: HandCash.app/Contents/{MacOS/HandCash, Resources/{app,node,*.cjs,…}}
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const outDir = path.join(root, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac')
const appPath = path.join(outDir, 'HandCash.app')
const contents = path.join(appPath, 'Contents')
const macos = path.join(contents, 'MacOS')
const resources = path.join(contents, 'Resources')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: opts.env ?? process.env,
    shell: false,
  })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

function pickSdk() {
  const sdkRoot = '/Library/Developer/CommandLineTools/SDKs'
  if (!fs.existsSync(sdkRoot)) {
    const fallback = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' })
    if (fallback.status === 0) return fallback.stdout.trim()
    throw new Error('no MacOSX SDK')
  }
  const names = fs
    .readdirSync(sdkRoot)
    .filter((n) => /^MacOSX\d.*\.sdk$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const preferred = [...names].reverse().filter((n) => !/^MacOSX26/.test(n))
  const candidates = preferred.length ? preferred : [...names].reverse()
  for (const name of candidates) {
    const sdk = path.join(sdkRoot, name)
    if (fs.existsSync(path.join(sdk, 'System/Library/Frameworks/WebKit.framework'))) return sdk
  }
  throw new Error(`no usable SDK under ${sdkRoot}`)
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
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory()) copyDir(s, d)
    else copyFile(s, d)
  }
}

function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>HandCash</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>io.handcash.brc100</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>HandCash</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key>
  <string>HandCash uses the camera to scan payment and sign-in QR codes, and for video calls with your friends.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>HandCash uses the microphone for calls with your friends.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist)
}

console.log(`==> native Mac package v${version} (${arch})`)

if (process.env.HANDCASH_SKIP_RENDERER !== '1') {
  console.log('==> build:renderer')
  run('npm', ['run', 'build:renderer'])
}

console.log('==> build:sidecar')
run('npm', ['run', 'build:sidecar'])

const sourcesDir = path.join(root, 'native-macos/Sources/HandCashShell')
const sources = fs
  .readdirSync(sourcesDir)
  .filter((n) => n.endsWith('.swift'))
  .map((n) => path.join(sourcesDir, n))
  .sort()
const sdk = pickSdk()
const binOut = path.join(root, 'native-macos/.build/release/HandCashShell')
fs.mkdirSync(path.dirname(binOut), { recursive: true })
console.log('==> swiftc HandCashShell', sdk)
run('swiftc', [
  '-O',
  '-o',
  binOut,
  '-sdk',
  sdk,
  '-target',
  `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
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
  ...sources,
])

rimraf(appPath)
fs.mkdirSync(macos, { recursive: true })
fs.mkdirSync(resources, { recursive: true })

copyFile(binOut, path.join(macos, 'HandCash'))
fs.chmodSync(path.join(macos, 'HandCash'), 0o755)

copyFile(path.join(root, 'dist-sidecar/bridgeSidecar.cjs'), path.join(resources, 'bridgeSidecar.cjs'))
copyFile(path.join(root, 'dist-sidecar/uiSidecar.cjs'), path.join(resources, 'uiSidecar.cjs'))
// Sourcemaps optional
for (const map of ['bridgeSidecar.cjs.map', 'uiSidecar.cjs.map']) {
  const src = path.join(root, 'dist-sidecar', map)
  if (fs.existsSync(src)) copyFile(src, path.join(resources, map))
}
copyFile(path.join(sourcesDir, 'handcash-page.js'), path.join(resources, 'handcash-page.js'))
copyDir(path.join(root, 'dist'), path.join(resources, 'app'))

// Bundle the Node used to build (CI / local).
const nodeSrc = process.execPath
copyFile(nodeSrc, path.join(resources, 'node'))
fs.chmodSync(path.join(resources, 'node'), 0o755)

const icns = path.join(root, 'build/icon.icns')
if (fs.existsSync(icns)) copyFile(icns, path.join(resources, 'AppIcon.icns'))

writeInfoPlist()

const entitlements = path.join(root, 'build/entitlements.mac.plist')
if (process.env.HANDCASH_ALLOW_UNSIGNED === '1' || !process.env.CSC_LINK) {
  console.log('==> ad-hoc codesign')
  run('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    entitlements,
    appPath,
  ])
} else {
  console.log('==> codesign (identity from env)')
  const identity = process.env.CSC_NAME || process.env.APPLE_IDENTITY
  if (!identity) throw new Error('set CSC_NAME / APPLE_IDENTITY for signed builds')
  run('codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--sign',
    identity,
    '--entitlements',
    entitlements,
    appPath,
  ])
}

// Zip + DMG for release channel naming (matches electron-updater asset names).
const zipName = `HandCash-${version}-${arch}-mac.zip`
const dmgName = `HandCash-${version}-${arch}-mac.dmg`
const releaseRoot = path.join(root, 'release')
fs.mkdirSync(releaseRoot, { recursive: true })

const zipPath = path.join(releaseRoot, zipName)
rimraf(zipPath)
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

const dmgPath = path.join(releaseRoot, dmgName)
rimraf(dmgPath)
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-dmg-'))
try {
  run('hdiutil', [
    'create',
    '-volname',
    'HandCash',
    '-srcfolder',
    appPath,
    '-ov',
    '-format',
    'UDZO',
    dmgPath,
  ])
} finally {
  rimraf(staging)
}

// Channel metadata (electron-updater shape so older Mac clients still find DMGs).
const latest = {
  version,
  files: [
    {
      url: dmgName,
      sha512: '',
      size: fs.statSync(dmgPath).size,
    },
  ],
  path: dmgName,
  sha512: '',
  releaseDate: new Date().toISOString(),
}
fs.writeFileSync(
  path.join(releaseRoot, 'latest-mac.yml'),
  [
    `version: ${version}`,
    `files:`,
    `  - url: ${dmgName}`,
    `    size: ${fs.statSync(dmgPath).size}`,
    `path: ${dmgName}`,
    `releaseDate: '${latest.releaseDate}'`,
  ].join('\n') + '\n',
)

console.log(`==> ${appPath}`)
console.log(`==> ${zipPath}`)
console.log(`==> ${dmgPath}`)
