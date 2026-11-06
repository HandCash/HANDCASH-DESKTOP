/**
 * Release Mobile for a Desktop release. Mobile is a Capacitor shell over this
 * repo's src/, so Mobile pins the Desktop commit it builds (ui-core-source.json
 * { gitSha, version }) and ships under its own 0.1.x version.
 *
 *   node scripts/release-mobile.mjs --mobile-dir ../HANDCASH-MOBILE [--sha <desktop sha>] [--push]
 *   node scripts/release-mobile.mjs --mobile-dir ../HANDCASH-MOBILE --check
 *
 * Release: sets the pin to this Desktop version + commit, bumps Mobile's patch
 * version, commits and tags v<mobile>. With --push, pushes branch + tag, which
 * starts Mobile's own Release Android APK workflow. Fails (exit 1) on anything
 * it cannot do; there are no prompts.
 * --check: exits 1 unless Mobile's pin matches Desktop's version.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function nextMobileVersion(v) {
  const m = SEMVER.exec(String(v).trim())
  if (!m) throw new Error(`Invalid Mobile version: ${v}`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** Problems that keep Mobile out of sync with Desktop; empty when in sync. */
export function syncProblems({ desktopVersion, walletUiVersion, pin }) {
  const problems = []
  if (!SEMVER.test(desktopVersion)) problems.push(`Desktop version "${desktopVersion}" is not semver`)
  if (walletUiVersion !== desktopVersion) {
    problems.push(`@handcash/wallet-ui ${walletUiVersion} != Desktop ${desktopVersion}`)
  }
  if (!pin || pin.version !== desktopVersion) {
    problems.push(`Mobile pin version ${pin?.version ?? '(missing)'} != Desktop ${desktopVersion}`)
  }
  if (!pin || !/^[0-9a-f]{40}$/.test(pin.gitSha ?? '')) {
    problems.push(`Mobile pin gitSha "${pin?.gitSha ?? ''}" is not a full commit sha`)
  }
  return problems
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)

function readDesktop() {
  return {
    desktopVersion: readJson(path.join(desktopRoot, 'package.json')).version,
    walletUiVersion: readJson(path.join(desktopRoot, 'packages/wallet-ui/package.json')).version,
  }
}

export function checkMobile(mobileDir) {
  const pinPath = path.join(mobileDir, 'ui-core-source.json')
  const pin = fs.existsSync(pinPath) ? readJson(pinPath) : null
  return syncProblems({ ...readDesktop(), pin })
}

/** Writes the pin + bumped Mobile version. Returns the new Mobile version. */
export function pinMobile(mobileDir, { desktopVersion, sha }) {
  const pkgPath = path.join(mobileDir, 'package.json')
  const pkg = readJson(pkgPath)
  pkg.version = nextMobileVersion(pkg.version)
  writeJson(pkgPath, pkg)
  writeJson(path.join(mobileDir, 'ui-core-source.json'), { gitSha: sha, version: desktopVersion })
  return pkg.version
}

function die(msg) {
  console.error(`[release-mobile] ${msg}`)
  process.exit(1)
}

function git(cwd, ...a) {
  return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function main() {
  const args = process.argv.slice(2)
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  const mobileDir = opt('--mobile-dir') && path.resolve(opt('--mobile-dir'))
  if (!mobileDir || !fs.existsSync(path.join(mobileDir, 'package.json'))) {
    die(`--mobile-dir must point at a Mobile checkout (got ${mobileDir ?? 'nothing'})`)
  }

  if (args.includes('--check')) {
    const problems = checkMobile(mobileDir)
    if (problems.length) die(`out of sync:\n  - ${problems.join('\n  - ')}`)
    console.log('Mobile pin matches Desktop')
    return
  }

  const { desktopVersion } = readDesktop()
  const tag = process.env.GITHUB_REF_NAME
  if (tag?.startsWith('v') && tag !== `v${desktopVersion}`) {
    die(`tag ${tag} does not match package.json ${desktopVersion}`)
  }
  const sha = opt('--sha') ?? git(desktopRoot, 'rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`bad Desktop sha: ${sha}`)

  if (git(mobileDir, 'status', '--porcelain')) die('Mobile worktree is dirty')
  const pinPath = path.join(mobileDir, 'ui-core-source.json')
  if (fs.existsSync(pinPath) && readJson(pinPath).version === desktopVersion) {
    console.log(`Mobile already pins Desktop ${desktopVersion} — nothing to release`)
    return
  }

  const mobileVersion = pinMobile(mobileDir, { desktopVersion, sha })
  const problems = checkMobile(mobileDir)
  if (problems.length) die(`out of sync after pin:\n  - ${problems.join('\n  - ')}`)

  const mobileTag = `v${mobileVersion}`
  git(mobileDir, 'add', 'package.json', 'ui-core-source.json')
  git(mobileDir, 'commit', '-m', `Release ${mobileTag} (UI v${desktopVersion}): pin Desktop core`)
  git(mobileDir, 'tag', mobileTag)
  console.log(`Mobile ${mobileTag} pins Desktop ${desktopVersion} @ ${sha.slice(0, 8)}`)

  if (args.includes('--push')) {
    git(mobileDir, 'push', 'origin', 'HEAD')
    git(mobileDir, 'push', 'origin', mobileTag)
    console.log(`Pushed ${mobileTag}; Mobile's Release Android APK workflow builds it`)
  } else {
    console.log(`Not pushed. Push with: git -C ${mobileDir} push origin HEAD ${mobileTag}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
