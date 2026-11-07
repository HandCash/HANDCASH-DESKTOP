import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FiatCurrencyMenu } from './FiatCurrencyMenu'

vi.mock('../hooks/useFiatCurrency', () => ({ useFiatCurrency: () => 'cad' }))

describe('balance chrome', () => {
  it('keeps the amount and currency without a heading or flag', () => {
    const html = renderToStaticMarkup(<FiatCurrencyMenu amountLabel="$12.34" />)
    expect(html).toContain('$12.34')
    expect(html).toContain('CAD · Choose display currency')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('Balance')
    expect(html).not.toContain('🇨🇦')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  it('keeps the pending amount and busy state', () => {
    const html = renderToStaticMarkup(<FiatCurrencyMenu amountLabel="$12.34" pending />)
    expect(html).toContain('>—</span>')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Loading CAD · Choose display currency')
    expect(html).not.toContain('$12.34')
  })
})
