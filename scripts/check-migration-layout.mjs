#!/usr/bin/env node
// Real presentation components, synthetic data, no wallet or network access.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sheets = [
  'vendor/aeon-ui-engine/packages/panda/styled-system/styles.css',
  'vendor/aeon-ui-engine/packages/panda/theme-runtime.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/scrollbars.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/electron.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/chrome.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/consumer-shell.css',
  'src/styles/handcash.css', 'src/styles/layout-compact.css',
]
const css = (await Promise.all(sheets.map((name) => fs.readFile(path.join(root, name), 'utf8')))).join('\n')
const { outputFiles } = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { applyBrandPalette } from '@aeon-ui/core'
    import { paletteForMode } from './src/wallet/handcashTheme'
    import { OnboardEntryPanel } from './src/components/OnboardEntryPanel'
    import { ImportSourceView } from './src/components/import/ImportSourceView'
    import { PairingCodeEntry } from './src/components/activity/PairingCodeEntry'
    const noop = () => {}
    const source = {
      id: 'layout-only', kind: 'handcash', label: 'Old HandCash wallet', createdAt: 0,
      fingerprint: 'fixture', secret: {}, handle: null,
      scan: { at: Date.now(), complete: true, checked: 24, addresses: [], via: 'handcash-utxo-set',
        holdings: [{ address: 'fixture', path: 'fixture', label: 'HandCash', wallets: '',
          uncompressed: false, cashSats: 1234567, cashCount: 4, dustCount: 2, dustSats: 2,
          itemCount: 12, itemCountCapped: false, error: null }] },
      lastSweep: null,
    }
    const root = createRoot(document.getElementById('root'))
    window.renderFixture = (face, mode) => {
      applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' })
      let content
      if (face === 'entry' || face === 'unsigned') {
        content = <OnboardEntryPanel session={face === 'entry' ? { handle: 'sample', source: 'upgrade', rememberedAt: 0 } : null} onSignIn={noop} onCreate={noop} onMigrate={noop} />
      } else if (face === 'pairing') {
        content = <section className="auth-screen"><h1>Authorize this computer</h1><PairingCodeEntry label="HandCash Desktop" length={6} attemptsLeft={3} confirm={async () => ({ ok: true })} approve={async () => { throw new Error('Presentation fixture cannot authorize a device') }} /></section>
      } else {
        const result = face === 'results'
        content = <section className="nav-section-body settings-detail settings-scroll" data-aeon-scope="legacy-import"><ImportSourceView
          source={result ? { ...source, lastSweep: { at: Date.now(), cashSats: 1234567, items: 12, held: {}, failed: 0, notes: [], status: 'completed' } } : source}
          face={result ? 'viewing' : face} progress={face === 'scanning' ? 'Checking old wallet addresses…' : 'Moving your wallet…'}
          percent={45} error={null} hintsOffer={null}
          onAskHints={noop} onBack={noop} onBrowse={noop} onRescan={noop} onReview={noop}
          onConfirm={noop} onCancel={noop} onRemove={noop} onPause={noop} /></section>
      }
      root.render(content)
    }
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  alias: Object.fromEntries(['core', 'primitives', 'react', 'tree'].map((name) => [`@aeon-ui/${name}`, path.join(root, `vendor/aeon-ui-engine/packages/${name}/src/index.ts`)])),
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.wasm': 'binary' },
  logLimit: 4,
  define: { __APP_VERSION__: '"layout-fixture"', 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
})
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-layout-'))
const browser = await chromium.launch()
try {
  for (const width of [360, 1440]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      await page.route('**/*', (route) => route.abort())
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setContent('<html><head></head><body><main id="root" style="max-width:720px;margin:0 auto;padding:24px 16px;box-sizing:border-box"></main></body></html>')
      await page.evaluate(({ width, theme }) => {
        document.documentElement.classList.toggle('layout-compact', width < 600)
        document.documentElement.dataset.aeonMode = theme
      }, { width, theme })
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: outputFiles[0].text })
      for (const face of ['entry', 'unsigned', 'scanning', 'reviewing', 'sweeping', 'results', 'pairing']) {
        await page.evaluate(({ face, theme }) => window.renderFixture(face, theme), { face, theme })
        await page.locator('#root > *').waitFor()
        await page.waitForTimeout(100)
        assert.deepEqual(errors, [], 'components render without runtime errors')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow: ${width}/${theme}/${face}`)
        assert.ok(await page.locator('#root').innerText(), 'nonempty presentation')
        const totals = page.locator('[data-aeon-part="totals"]')
        if (await totals.count()) {
          assert.equal(await totals.evaluate((el) => getComputedStyle(el).display), 'flex', 'totals use styled Aeon metrics')
          const chips = await totals.locator(':scope > span').evaluateAll((els) => els.map((el) => ({ display: getComputedStyle(el).display, direction: getComputedStyle(el).flexDirection })))
          assert.equal(chips.length, 2)
          assert.ok(chips.every((chip) => chip.display === 'flex' && chip.direction === 'column'), 'values and labels remain separate')
        }
        await page.screenshot({ path: path.join(out, `${width}-${theme}-${face}.png`), fullPage: true })
      }
      await page.close()
    }
  }
  console.log('Migration and pairing presentation checks passed; screenshots: ' + out)
} finally {
  await browser.close()
}
