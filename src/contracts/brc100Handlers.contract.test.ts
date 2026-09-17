import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTION_BRC100_METHODS,
  MIGRATION_BRC100_METHODS,
  PUBLIC_BRC100_METHODS,
} from './brc100'
import {
  BRC100_HANDLER_MANIFEST,
  brc100HandlerOwner,
} from './brc100Handlers'

describe('BRC-100 handler manifest', () => {
  it('owns every method named by the protocol contract', () => {
    for (const method of [
      ...PUBLIC_BRC100_METHODS,
      ...ACTION_BRC100_METHODS,
      ...MIGRATION_BRC100_METHODS,
    ]) {
      expect(brc100HandlerOwner(method), method).not.toBeNull()
    }
  })

  it('does not allow a switch-only handler', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/wallet/brc100Handler.ts'),
      'utf8',
    )
    const cases = [...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]!)
    const undeclared = cases.filter(
      (method) =>
        !Object.prototype.hasOwnProperty.call(BRC100_HANDLER_MANIFEST, method),
    )
    expect(undeclared).toEqual([])
  })
})
