import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OnboardEmailPanel, ONBOARD_EMAIL_LEDE } from './OnboardEmailPanel'

describe('OnboardEmailPanel', () => {
  it('asks for an optional sign-in email and says why', () => {
    const html = renderToStaticMarkup(createElement(OnboardEmailPanel, { onDone: () => {} }))
    expect(html).toContain('Add a sign-in email')
    expect(html).toContain('You can add it later in Settings.')
    expect(html).toContain('data-aeon-state="entering"')
    expect(html).toContain('type="email"')
    expect(html).toContain('Send code')
    expect(html).toContain('Skip for now')
  })

  it('says HandCash keeps only a keyed hash', () => {
    expect(ONBOARD_EMAIL_LEDE).toContain('keyed hash')
  })
})
