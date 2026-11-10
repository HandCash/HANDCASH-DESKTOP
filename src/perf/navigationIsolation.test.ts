import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/WalletNav.tsx', import.meta.url), 'utf8')
const panels = [
  'TransactionsPanel',
  'FriendsPanel',
  'IdentityPanel',
  'SettingsPanel',
  'ConnectedAppsPanel',
]
const declarations = panels.map((panel) => {
  const declaration = `const Memo${panel} = memo(${panel})`
  return declaration
})

describe('kept-alive navigation render boundaries', () => {
  it('isolates every light panel from parent navigation renders', () => {
    for (const [index, panel] of panels.entries()) {
      expect(source).toContain(declarations[index])
      expect(source).toContain(`<Memo${panel}`)
      expect(source).not.toMatch(new RegExp(`<${panel}[\\s/>]`))
    }
  })

  it('keeps the Apps callback stable so its memo boundary can bail out', () => {
    expect(source).toContain('const showBrowserTabs = useCallback(() => setTabSwitcherOpen(true), [])')
    expect(source).toContain('onShowTabs={showBrowserTabs}')
  })
})

// Opt-in real React/browser probe; no wallet data, credentials or network.
// Exercises the exact memo declarations above with synthetic panel bodies,
// not the full wallet or device navigation latency.
describe.skipIf(!process.env.HANDCASH_PERF)('navigation isolation browser probe', () => {
  it('skips unrelated projections but keeps local updates and changed props live', async () => {
    const { build } = await import('esbuild')
    const { chromium } = await import('@playwright/test')
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'js',
        contents: `
          import React, { memo, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          const counts = {}
          let updateLocal
          function panel(name) {
            return function Panel() {
              counts[name] = (counts[name] || 0) + 1
              const [value, setValue] = useState(0)
              if (name === 'TransactionsPanel') updateLocal = () => setValue(v => v + 1)
              return React.createElement('span', null, value)
            }
          }
          ${panels.map(p => `const ${p} = panel('${p}')`).join('\n')}
          ${declarations.join('\n')}
          const raw = [${panels.join(',')}]
          const isolated = [${panels.map(p => 'Memo' + p).join(',')}]
          const root = createRoot(document.getElementById('root'))
          const profile = {}
          const apps = []
          const showTabs = () => {}
          function render(components, chain = 'main') {
            flushSync(() => root.render(React.createElement('div', null,
              ...components.map((Component, i) => React.createElement(Component, {
                key: i,
                ...(i < 2 ? { chain } : i === 2 ? { profile } : i === 4
                  ? { apps, openTabCount: 0, onShowTabs: showTabs } : {})
              }))
            )))
          }
          window.probe = () => {
            render(raw)
            for (const name of Object.keys(counts)) counts[name] = 0
            for (let i = 0; i < 24; i++) render(raw)
            const baseline = { ...counts }
            render(isolated)
            for (const name of Object.keys(counts)) counts[name] = 0
            for (let i = 0; i < 24; i++) render(isolated)
            const navigation = { ...counts }
            flushSync(updateLocal)
            const local = { ...counts }
            render(isolated, 'test')
            return { baseline, navigation, local, changed: { ...counts } }
          }
        `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      const result = await page.evaluate(() =>
        (window as unknown as { probe: () => Record<string, Record<string, number>> }).probe(),
      )
      for (const panel of panels) {
        expect(result.baseline![panel]).toBe(24)
        expect(result.navigation![panel]).toBe(0)
      }
      expect(result.local!.TransactionsPanel).toBe(1)
      expect(result.changed!.TransactionsPanel).toBe(2)
      expect(result.changed!.FriendsPanel).toBe(1)
      expect(result.changed!.IdentityPanel).toBe(0)
      console.info('[navigation] 24 parent updates: 120 synthetic panel renders before, 0 after; local and chain updates preserved')
    } finally {
      await browser.close()
    }
  }, 30_000)
})
