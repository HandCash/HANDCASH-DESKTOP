import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Approval UI never takes focus: a stray Enter must not approve an app write
// (migration import grant, spend, permission).
describe('ActionPermissionDialog focus', () => {
  it('never focuses a decision button on open', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ActionPermissionDialog.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).not.toMatch(/autoFocus/)
  })
})
