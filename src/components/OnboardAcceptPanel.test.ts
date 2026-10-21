import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OnboardAcceptPanel } from './OnboardAcceptPanel'

function option(html: string, value: string): string {
  const match = html.match(new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*value="${value}"[\\s\\S]*?</label>`))
  expect(match, value).not.toBeNull()
  return match![0]
}

describe('OnboardAcceptPanel', () => {
  it('asks what the wallet accepts and names the default', () => {
    const html = renderToStaticMarkup(createElement(OnboardAcceptPanel, { onDone: () => {} }))
    expect(html).toContain('What do you want to accept?')
    expect(html).toContain('Just Bitcoin SV is the default. You can change this later in Settings.')
  })

  it('offers Just Bitcoin SV, preselected, and Bitcoin SV and crypto', () => {
    const html = renderToStaticMarkup(createElement(OnboardAcceptPanel, { onDone: () => {} }))
    const bitcoin = option(html, 'bitcoin')
    const all = option(html, 'all')
    expect(bitcoin).toContain('Just Bitcoin SV')
    expect(bitcoin).toContain('checked')
    expect(bitcoin).toContain('is-selected')
    expect(all).toContain('Bitcoin SV and crypto')
    expect(all).not.toContain('checked')
  })

  it('never calls Bitcoin SV a crypto', () => {
    const html = renderToStaticMarkup(createElement(OnboardAcceptPanel, { onDone: () => {} }))
    expect(html).not.toMatch(/other crypto|all crypto|crypto including/i)
  })
})
