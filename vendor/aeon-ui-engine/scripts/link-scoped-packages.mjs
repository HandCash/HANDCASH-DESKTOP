/**
 * Materialize `node_modules/@aeon-ui/*` → `aeon-ui-engine/packages/*`
 * so Next.js / Vite / Node can resolve scoped imports without bundler aliases.
 *
 * Runs as `aeon-ui-engine` postinstall (uses INIT_CWD) or via `npx aeon-ui link`.
 *
 * @example
 * node ./scripts/link-scoped-packages.mjs
 * node ./scripts/link-scoped-packages.mjs --cwd /path/to/app
 */

import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/** Packages exposed under `@aeon-ui/<name>` for consumers. */
export const SCOPED_PACKAGES = [
  'core',
  'primitives',
  'react',
  'ui',
  'panda',
  'schemas',
  'surface',
  'vue',
  'solid',
  'svelte',
]

/**
 * Absolute path to the `aeon-ui-engine` package root (npm install or monorepo).
 */
export function resolveEngineRoot(opts = {}) {
  if (opts.engineRoot) return path.resolve(opts.engineRoot)
  if (process.env.AEON_UI_ROOT) return path.resolve(process.env.AEON_UI_ROOT)

  try {
    const require = createRequire(import.meta.url)
    return path.dirname(require.resolve('aeon-ui-engine/package.json'))
  } catch {
    // Running from the monorepo checkout (this file lives in scripts/).
    return path.resolve(scriptDir, '..')
  }
}

/**
 * Consumer `node_modules` where `@aeon-ui/*` should appear.
 * Prefer INIT_CWD (npm/pnpm/yarn set this to the install project).
 */
export function resolveTargetNodeModules(opts = {}) {
  if (opts.nodeModules) return path.resolve(opts.nodeModules)
  if (opts.cwd) return path.join(path.resolve(opts.cwd), 'node_modules')

  // Prefer INIT_CWD (npm/pnpm/yarn set this to the install project).
  // Skip when postinstall runs inside the engine package itself during a
  // monorepo install — workspace already provides @aeon-ui/*.
  if (process.env.INIT_CWD) {
    const initCwd = path.resolve(process.env.INIT_CWD)
    const engineRoot = resolveEngineRoot(opts)
    if (initCwd === engineRoot) {
      return path.join(engineRoot, 'node_modules')
    }
    return path.join(initCwd, 'node_modules')
  }

  const engineRoot = resolveEngineRoot(opts)
  // Installed as dependency: …/node_modules/aeon-ui-engine
  const parent = path.dirname(engineRoot)
  if (path.basename(parent) === 'node_modules') {
    return parent
  }

  // Monorepo / direct run: link into engine's own node_modules
  return path.join(engineRoot, 'node_modules')
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function sameTarget(linkPath, absTarget) {
  try {
    const current = readlinkSync(linkPath)
    const resolved = path.isAbsolute(current)
      ? path.normalize(current)
      : path.resolve(path.dirname(linkPath), current)
    if (resolved === absTarget) return true
  } catch {
    /* not a symlink or unreadable */
  }
  try {
    return realpathSync(linkPath) === realpathSync(absTarget)
  } catch {
    return false
  }
}

/**
 * @param {{ cwd?: string, engineRoot?: string, nodeModules?: string, quiet?: boolean, force?: boolean }} [opts]
 * @returns {{ linked: string[], skipped: string[], missing: string[], targetNodeModules: string, engineRoot: string }}
 */
export function linkScopedPackages(opts = {}) {
  const quiet = opts.quiet ?? false
  const force = opts.force ?? false
  const engineRoot = resolveEngineRoot(opts)
  const targetNodeModules = resolveTargetNodeModules({ ...opts, engineRoot })
  const scopeDir = path.join(targetNodeModules, '@aeon-ui')
  const packagesRoot = path.join(engineRoot, 'packages')

  const linked = []
  const skipped = []
  const missing = []

  mkdirSync(scopeDir, { recursive: true })

  for (const name of SCOPED_PACKAGES) {
    const absTarget = path.join(packagesRoot, name)
    if (!existsSync(absTarget)) {
      missing.push(name)
      continue
    }

    const linkPath = path.join(scopeDir, name)

    if (existsSync(linkPath) || isSymlink(linkPath)) {
      if (sameTarget(linkPath, absTarget)) {
        skipped.push(name)
        continue
      }
      // Do not clobber pnpm/npm workspace links unless --force
      if (!force) {
        skipped.push(name)
        continue
      }
      rmSync(linkPath, { recursive: true, force: true })
    }

    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(absTarget, linkPath, type)
    linked.push(name)
  }

  if (!quiet) {
    const rel = (n) => `@aeon-ui/${n}`
    for (const n of linked) console.log(`  link ${rel(n)} → packages/${n}`)
    for (const n of skipped) console.log(`  skip ${rel(n)} (already present)`)
    for (const n of missing) console.log(`  miss ${rel(n)} (not in engine)`)
    if (linked.length === 0 && skipped.length > 0) {
      console.log(`aeon-ui link: ${skipped.length} package(s) already present in ${targetNodeModules}`)
    } else if (linked.length > 0) {
      console.log(`aeon-ui link: linked ${linked.length} package(s) into ${targetNodeModules}`)
    }
  }

  return { linked, skipped, missing, targetNodeModules, engineRoot }
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cwd' && argv[i + 1]) {
      opts.cwd = argv[++i]
    } else if (a === '--engine-root' && argv[i + 1]) {
      opts.engineRoot = argv[++i]
    } else if (a === '--quiet' || a === '-q') {
      opts.quiet = true
    } else if (a === '--force' || a === '-f') {
      opts.force = true
    }
  }
  return opts
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  }
})()

if (isMain) {
  try {
    linkScopedPackages(parseArgs(process.argv.slice(2)))
  } catch (err) {
    console.error('aeon-ui link failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
