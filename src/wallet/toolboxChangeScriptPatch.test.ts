/** Guard durability fixes in the HandCash-owned engine source. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function engineSource(relative: string): string {
  return readFileSync(
    path.join(repoRoot, 'packages', 'wallet-engine', 'src', relative),
    'utf8',
  )
}

describe('wallet-engine durability source', () => {
  it('hydrates the one selected change script after a script-free scan', () => {
    const source = engineSource('storage/StorageIdb.ts')
    expect(source).toContain('if (output.lockingScript == null)')
    expect(source).toContain('findOutputById(output.outputId')
  })

  it('bounds ordinary funding reads and retains the full-history fallback', () => {
    const source = engineSource('storage/methods/actionBatch.ts')
    expect(source).toContain('const maxPages = 5')
    expect(source).toContain('findAvailableManagedChangeInputs')
  })

  it('reserves every explicit input absent from the batch workspace', () => {
    const source = engineSource(
      'signer/actionBatch/ActionBatchWorkspace.ts',
    )
    expect(source).not.toContain('discardedStagedTxids.has(outpoint.txid)')
    expect(source).toContain('!this.state.reserved.has(key)')
  })
})
