import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  containsRetiredFungibleRequest,
  isRetiredFungibleBasket,
} from './retiredFungible'

const walletRoot = join(process.cwd(), 'src', 'wallet')

function productionTypeScript(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionTypeScript(path)
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name === 'retiredFungible.ts' ||
      entry.name === 'retiredFungible.testFixtures.ts'
    ) {
      return []
    }
    return [path]
  })
}

describe('retired fungible protocol boundary', () => {
  it('keeps obsolete protocol literals inside the quarantine module', () => {
    const violations = productionTypeScript(walletRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return /1sat-ft|BRC-175/i.test(source)
        ? [path.replace(`${process.cwd()}/`, '')]
        : []
    })
    expect(violations).toEqual([])
  })

  it('does not expose obsolete token APIs', () => {
    const barrel = readFileSync(join(walletRoot, 'token', 'index.ts'), 'utf8')
    expect(barrel).not.toMatch(
      /Colour|OnesatFt|listColour|sendColour|burnColour|settleLegacy/,
    )
  })

  it('fails closed for historical basket, tag, and remittance shapes', () => {
    expect(isRetiredFungibleBasket('1sat-ft')).toBe(true)
    expect(
      containsRetiredFungibleRequest({
        outputs: [{ basket: '1sat-ft' }],
      }),
    ).toBe(true)
    expect(
      containsRetiredFungibleRequest({
        insertionRemittance: {
          basket: '1sat',
          customInstructions: JSON.stringify({ p: '1sat-ft' }),
        },
      }),
    ).toBe(true)
    expect(
      containsRetiredFungibleRequest({
        outputs: [{ basket: 'bsv21', tags: ['bsv21'] }],
      }),
    ).toBe(false)
  })
})
