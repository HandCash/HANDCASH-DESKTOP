#!/usr/bin/env node
/**
 * Re-apply the HandCash edits to `@bsv/wallet-toolbox-client`, then regenerate
 * `patches/@bsv+wallet-toolbox-client+<version>.patch`.
 *
 *   node scripts/patch-wallet-toolbox.mjs [--no-generate]
 *
 * Run this after every toolbox bump. A patch pinned to the old version does not
 * apply, `patch-package` fails in `postinstall`, and every release build dies at
 * `npm ci` — which is exactly how 1.2.268 and 1.2.269 shipped no installers.
 *
 * The package publishes one rolldown bundle per module format, so each edit is
 * applied to both `index.client.mjs` and `index.client.cjs`. Every edit asserts
 * it matched exactly once: an upstream rewrite must fail loudly here rather than
 * silently drop a custody behaviour.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'node_modules/@bsv/wallet-toolbox-client')
const bundles = ['out/index.client.mjs', 'out/index.client.cjs']

/**
 * Each edit is `find` → `replace`, applied to both bundles. `find` must be
 * present exactly once before the edit and absent after it, so re-running is a
 * no-op rather than a double application.
 */
const edits = [
  {
    name: 'reserve explicit inputs already present in sharedBeef',
    // Without this, resolveInputOutput synthesizes an explicit input from beef
    // (outputId -1) and commitActionBatch then rejects the real storage row as
    // unreserved: "input X was not reserved by this action batch". Inputs that
    // are external only stay fine — extend finds nothing to reserve and
    // persistAction skips the missing storage row.
    find:
      'return !this.state.staged.has(key) && !this.state.explicit.has(key) && !this.state.reserved.has(key) && ' +
      '(this.state.discardedStagedTxids.has(outpoint.txid) || this.state.sharedBeef.findTxid(outpoint.txid)?.tx == null);',
    replace:
      'return !this.state.staged.has(key) && !this.state.explicit.has(key) && !this.state.reserved.has(key);',
  },
  {
    name: 'restore the locking script of the chosen change input',
    // The candidate scan above runs with `noScript: true`, which clears
    // lockingScript on every row, and validateOutputScript only restores it when
    // scriptOffset/scriptLength are set (script offloaded into rawTx). Rows that
    // store the script inline returned unchanged, so createAction reached
    // Array.from(undefined) and no send could succeed. Re-read the one chosen row.
    find:
      '\t\t\t\tawait this.validateOutputScript(output, dbTrx);\n' +
      '\t\t\t}\n' +
      '\t\t\treturn output;',
    replace:
      '\t\t\t\tawait this.validateOutputScript(output, dbTrx);\n' +
      '\t\t\t\tif (output.lockingScript == null) {\n' +
      '\t\t\t\t\tconst stored = await this.findOutputById(output.outputId, dbTrx);\n' +
      '\t\t\t\t\tif (stored?.lockingScript != null) output.lockingScript = stored.lockingScript;\n' +
      '\t\t\t\t}\n' +
      '\t\t\t}\n' +
      '\t\t\treturn output;',
  },
]

function occurrences(haystack, needle) {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count += 1
  }
  return count
}

const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
let changed = 0

for (const bundle of bundles) {
  const file = path.join(pkgDir, bundle)
  const before = fs.readFileSync(file, 'utf8')
  let source = before
  for (const edit of edits) {
    if (occurrences(source, edit.replace) === 1) continue // already applied
    const found = occurrences(source, edit.find)
    if (found !== 1) {
      throw new Error(
        `${bundle}: expected 1 match for "${edit.name}", found ${found}. ` +
          `The toolbox changed — re-derive this edit against ${version}.`,
      )
    }
    source = source.replace(edit.find, edit.replace)
  }

  if (source !== before) {
    fs.writeFileSync(file, source)
    changed += 1
  }
}

console.log(
  changed === 0
    ? `@bsv/wallet-toolbox-client ${version}: already patched`
    : `@bsv/wallet-toolbox-client ${version}: applied ${edits.length} edits to ${changed} bundle(s)`,
)

if (process.argv.includes('--no-generate')) process.exit(0)

for (const stale of fs.readdirSync(path.join(root, 'patches'))) {
  if (/^@bsv\+wallet-toolbox-client\+/.test(stale) && !stale.includes(`+${version}.patch`)) {
    fs.rmSync(path.join(root, 'patches', stale))
    console.log(`removed stale ${stale}`)
  }
}

execFileSync(path.join(root, 'node_modules/.bin/patch-package'), ['@bsv/wallet-toolbox-client'], {
  cwd: root,
  stdio: 'inherit',
  // patch-package installs a pristine copy to diff against. An invalid setting
  // in a developer's own ~/.npmrc would fail that install with an unrelated
  // error, so diff against npm's defaults only.
  env: { ...process.env, npm_config_userconfig: '/dev/null' },
})
