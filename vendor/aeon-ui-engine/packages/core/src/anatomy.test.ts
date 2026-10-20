import { describe, expect, it } from 'vitest'
import * as anatomies from './anatomy.js'
import { scopeAttrs } from './attrs.js'

describe('anatomy', () => {
  it('carries its scope so scopeAttrs emits data-aeon-scope', () => {
    expect(anatomies.composerAnatomy.scope).toBe('composer')
    expect(scopeAttrs(anatomies.dialogAnatomy.scope, anatomies.dialogAnatomy.content)).toMatchObject({
      'data-aeon-scope': 'dialog',
      'data-aeon-part': 'content',
    })
  })

  it('every exported anatomy has a non-empty scope', () => {
    for (const [name, value] of Object.entries(anatomies)) {
      if (!name.endsWith('Anatomy')) continue
      expect(typeof (value as { scope?: unknown }).scope, name).toBe('string')
      expect((value as { scope: string }).scope.length, name).toBeGreaterThan(0)
    }
  })
})
