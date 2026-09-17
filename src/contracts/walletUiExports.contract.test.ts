import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@handcash/wallet-ui public surface', () => {
  it('exports explicit entrypoints instead of wallet internals', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), 'packages/wallet-ui/package.json'),
        'utf8',
      ),
    ) as { exports?: Record<string, string> }
    const exports = manifest.exports ?? {}
    expect(
      Object.keys(exports).some(
        (key) =>
          key.startsWith('./wallet/') && key.includes('*') ||
          key.startsWith('./components/') && key.includes('*') ||
          key.startsWith('./machines/') && key.includes('*'),
      ),
    ).toBe(false)
    expect(exports['./App']).toBe('../../src/App.tsx')
    expect(exports['./wallet/browserPolyfills']).toBe(
      '../../src/wallet/browserPolyfills.ts',
    )
  })
})
