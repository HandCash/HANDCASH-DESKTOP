#!/usr/bin/env node
/**
 * Refuse a stale `@bsv/wallet-toolbox-client` patch.
 *
 * `patch-package` pins a patch to one exact version. Bumping the dependency
 * without running `scripts/patch-wallet-toolbox.mjs` leaves a patch that cannot
 * apply, so `postinstall` fails, `npm ci` fails, and every release workflow dies
 * before it builds an installer — silently, unless someone reads the CI logs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const PACKAGE = '@bsv/wallet-toolbox-client'

export function assertToolboxPatchPinned(root = process.cwd()) {
  const require = createRequire(path.join(root, 'package.json'))
  const { version } = JSON.parse(
    fs.readFileSync(require.resolve(`${PACKAGE}/package.json`), 'utf8'),
  )
  const expected = `${PACKAGE.replace('/', '+')}+${version}.patch`
  const present = fs
    .readdirSync(path.join(root, 'patches'))
    .filter((name) => name.startsWith(`${PACKAGE.replace('/', '+')}+`))

  if (!present.includes(expected)) {
    throw new Error(
      `patches/${expected} is missing (found: ${present.join(', ') || 'none'}).\n` +
        `Installed ${PACKAGE} is ${version}. Run: node scripts/patch-wallet-toolbox.mjs`,
    )
  }
  return { version, patch: expected }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const { version, patch } = assertToolboxPatchPinned(root)
    console.log(`${PACKAGE} ${version} patched by ${patch}`)
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
