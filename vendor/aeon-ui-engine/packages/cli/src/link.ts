import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type LinkOptions = {
  cwd?: string
  quiet?: boolean
  force?: boolean
}

function resolveLinkScript(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const fromMonorepo = join(here, '../../../scripts/link-scoped-packages.mjs')
  if (existsSync(fromMonorepo)) return fromMonorepo

  try {
    const require = createRequire(import.meta.url)
    const engineRoot = dirname(require.resolve('aeon-ui-engine/package.json'))
    return join(engineRoot, 'scripts/link-scoped-packages.mjs')
  } catch {
    throw new Error(
      'Could not find scripts/link-scoped-packages.mjs (aeon-ui-engine not installed?)',
    )
  }
}

/**
 * Symlink `node_modules/@aeon-ui/*` → `aeon-ui-engine/packages/*`.
 * Prefer the postinstall hook; this command re-runs linking manually.
 */
export function linkAeon(options: LinkOptions = {}) {
  const script = resolveLinkScript()
  const args = [script]
  if (options.cwd) {
    args.push('--cwd', options.cwd)
  }
  if (options.quiet) {
    args.push('--quiet')
  }
  if (options.force) {
    args.push('--force')
  }

  const result = spawnSync(process.execPath, args, {
    stdio: options.quiet ? 'pipe' : 'inherit',
    env: process.env,
    cwd: options.cwd ?? process.cwd(),
  })

  if (result.status !== 0 && result.status !== null) {
    const err = result.stderr?.toString() || `link exited with code ${result.status}`
    throw new Error(err)
  }

  return {
    cwd: options.cwd ?? process.cwd(),
    status: result.status ?? 0,
  }
}
