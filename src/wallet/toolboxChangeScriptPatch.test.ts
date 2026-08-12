/**
 * Guards the `@bsv/wallet-toolbox-client` patch that makes any send possible at all.
 *
 * `StorageIdb.allocateChangeInput` scans candidates with `noScript: true`, which
 * clears `lockingScript` on every row, then re-hydrates the chosen output only
 * through `validateOutputScript` — and that returns unchanged when
 * `scriptOffset` / `scriptLength` are unset, which is how rows that store the
 * script inline are saved. `createAction` then called `asString(undefined)` and
 * threw `undefined is not iterable`, so every payment failed.
 *
 * A toolbox upgrade that drops the patch would silently break all sends, so
 * assert the shipped code still re-reads the chosen row.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

function readToolboxFile(relative: string): string {
  const pkgJson = require.resolve('@bsv/wallet-toolbox-client/package.json')
  return readFileSync(path.join(path.dirname(pkgJson), relative), 'utf8')
}

describe('toolbox allocateChangeInput script hydration patch', () => {
  const source = readToolboxFile('out/src/storage/StorageIdb.js')

  it('still strips scripts during the candidate scan (patch premise holds)', () => {
    expect(source).toContain('noScript: true')
  })

  it('falls back to re-reading the chosen change output with its script', () => {
    const allocate = source.slice(
      source.indexOf('async allocateChangeInput('),
      source.indexOf('async getProvenOrRawTx('),
    )
    expect(allocate).not.toHaveLength(0)
    expect(allocate).toContain('await this.validateOutputScript(output, dbTrx)')
    expect(allocate).toContain('output.lockingScript == null')
    expect(allocate).toContain('this.findOutputById(output.outputId, dbTrx)')
  })

  it('keeps asString as the crash site the patch protects', () => {
    const createAction = readToolboxFile('out/src/storage/methods/createAction.js')
    expect(createAction).toContain('asString)(o.lockingScript)')
  })
})
