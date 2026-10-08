import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BSV sends spend coins the wallet already holds; `prepareSpendHeal` promotes
 * change only when confirmed coins fall short. A region-entry promote walks
 * every pending local-change tx behind toolbox monitor holds — 0.1.669/0.1.670
 * sat in "preparing" until the 90s watchdog with 3.2M sat confirmed.
 */
const ON_DEMAND_SENDS = ['sendBrc29Payment.ts', 'sendPayment.ts']

describe('BSV sends prepare on demand', () => {
  for (const file of ON_DEMAND_SENDS) {
    it(`${file} does not force a region-entry promote`, () => {
      const source = readFileSync(join(__dirname, file), 'utf8')
      expect(source).not.toMatch(/promote:\s*'(light|full)'/)
    })
  }
})
