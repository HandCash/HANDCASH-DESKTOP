/** Guard the Toolbox release that upstreamed our change-script hydration fix. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

function installedToolboxVersion(): string {
  const pkgJson = require.resolve('@bsv/wallet-toolbox-client/package.json')
  return (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version
}

describe('toolbox change-script hydration release floor', () => {
  it('uses a release containing the upstream StorageIdb fix', () => {
    const [major, minor, patch] = installedToolboxVersion()
      .split('.')
      .map((part) => Number.parseInt(part, 10))
    expect(
      major > 2 ||
        (major === 2 && (minor > 1 || (minor === 1 && patch >= 24))),
    ).toBe(true)
  })
})
