import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTH_ENTRY_TAGLINES } from './AuthEntryTaglines'

describe('AuthEntryTaglines', () => {
  it('rotates one abstract positive capability thought each', () => {
    expect(AUTH_ENTRY_TAGLINES.length).toBeGreaterThanOrEqual(6)
    const joined = AUTH_ENTRY_TAGLINES.join(' ').toLowerCase()
    expect(joined).toMatch(/exchange|peers|settle|equals/)
    expect(joined).toMatch(/business|trade/)
    expect(joined).toMatch(/define|shape|terms|present/)
    // No commerce-slot examples or technical stack language.
    expect(joined).not.toMatch(/\b(tip|dinner|checkout|invoice|supplier|suppliers)\b/)
    expect(joined).not.toMatch(/\b(key|keys|ledger|distributed|topology|fractional)\b/)
    for (const line of AUTH_ENTRY_TAGLINES) {
      expect(line.length).toBeLessThan(60)
      expect(line).not.toMatch(/alignity|purple|subtitle/i)
      // One thought: no stacked sentences/clauses or negative framing.
      expect(line).not.toMatch(/\.\s/)
      expect(line).not.toMatch(/—|--/)
      expect(line).not.toMatch(/\b(not|no|never|without|destroy|dissolve|landlord|rented)\b/i)
    }
  })

  it('sits under the entry CTAs and respects reduced motion', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/auth/AuthEntryTaglines.tsx'),
      'utf8',
    )
    expect(src).toContain('prefers-reduced-motion')
    expect(src).toContain('data-aeon-part="entry-tagline"')
    const auth = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/AuthScreen.tsx'),
      'utf8',
    )
    expect(auth).toContain('auth-entry-actions')
    expect(auth).toContain('AuthEntryTaglines')
    expect(auth.indexOf('auth-entry-actions')).toBeLessThan(auth.indexOf('<AuthEntryTaglines'))
  })
})
