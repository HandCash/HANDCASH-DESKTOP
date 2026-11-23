#!/usr/bin/env node
// Geometry fixtures for shared wallet chrome; no wallet, keys or network needed.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sheets = [
  'vendor/aeon-ui-engine/packages/panda/styled-system/styles.css',
  'vendor/aeon-ui-engine/packages/panda/theme-runtime.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/chrome.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/consumer-shell.css',
  'src/styles/handcash.css',
  'src/styles/layout-compact.css',
]
const css = (await Promise.all(sheets.map((name) => fs.readFile(path.join(root, name), 'utf8')))).join('\n')
const { outputFiles } = await build({
  stdin: {
    contents: `import { applyBrandPalette } from '@aeon-ui/core'; import { paletteForMode } from './src/wallet/handcashTheme'; window.applyFixtureTheme = (mode) => applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' });`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
})
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-chrome-'))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  for (const width of [360, 430, 1440]) {
    for (const theme of ['dark', 'light']) {
      const compact = width < 600
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const rows = [false, true].map((description) => `<button class="settings-nav-row" data-aeon-scope="listRow" data-aeon-part="root"><span data-aeon-part="leading"><span class="settings-row-icon">⚙</span></span><span data-aeon-part="label">${description ? 'Backup' : 'Currency'}</span>${description ? '<span data-aeon-part="description">History saved off this device</span>' : ''}<span data-aeon-part="trailing">›</span></button>`).join('')
      await page.setContent(`<html class="${compact ? 'layout-compact' : ''}" data-aeon-mode="${theme}"><head></head><body><main style="padding:16px;max-width:800px;margin:auto"><section class="wallet-hero" data-aeon-scope="wallet-hero" data-aeon-shell="${compact ? 'compact' : 'wide'}"><div class="connected-panel-head wallet-hero-head"><div class="wallet-nav-actions-pill wallet-hero-metric"><button class="fiat-currency-trigger"><h2 class="wallet-hero-title"><span class="wallet-hero-title-full">Balance</span><span class="wallet-hero-title-approx">~</span></h2><span class="wallet-hero-metric-amount">$123.45</span><span class="fiat-currency-flag">🇺🇸</span><svg class="wallet-account-caret" width="16" height="16"></svg></button></div><div class="wallet-nav-actions-pill wallet-hero-identity-chrome"><div class="wallet-account-menu" data-aeon-scope="wallet-account-menu"><div class="wallet-hero-identity-row"><button class="wallet-hero-identity" data-aeon-part="trigger"><span class="profile-avatar" data-aeon-part="avatar">A</span><span>$alice</span><svg width="10" height="10"></svg></button></div></div></div></div><div class="wallet-hero-main"><div class="wallet-balance-block"><div class="wallet-balance-slot"><button class="wallet-balance">1.2345 BSV</button></div></div></div></section><p>Shared sync status</p><div class="titlebar-end"><button class="status-pill"><span class="status-dot"></span><span class="status-pill-label" data-aeon-scope="text-overflow" data-aeon-part="root" data-aeon-overflow="carousel" data-aeon-state="fits"><span data-aeon-part="viewport"><span data-aeon-part="track"><span data-aeon-part="item">Synced</span></span></span></span></button></div><section data-aeon-scope="settings"><h2>Settings</h2>${rows}</section><p>Canonical coin marks</p><div style="display:flex;gap:16px">${['btc', 'bch', 'doge', 'ltc'].map((coin) => `<div><svg data-chain-mark="${coin}" width="40" height="40" viewBox="0 0 32 32"><circle class="chain-mark-disc" cx="16" cy="16" r="16"/><text x="16" y="21" text-anchor="middle" fill="white">${coin === 'doge' ? 'Ð' : coin === 'ltc' ? 'Ł' : '₿'}</text></svg><p>${coin.toUpperCase()}</p></div>`).join('')}</div></main></body></html>`)
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: outputFiles[0].text })
      await page.evaluate((mode) => window.applyFixtureTheme(mode), theme)
      const bounds = async (selector) => page.locator(selector).first().boundingBox()
      const avatar = await bounds('.profile-avatar')
      assert.equal(avatar.width, avatar.height, 'profile avatar stays square')
      const metric = await bounds('.wallet-hero-metric')
      const identity = await bounds('.wallet-hero-identity-chrome')
      assert.ok(identity.x - (metric.x + metric.width) <= 12, `no spare space between metric and profile: ${JSON.stringify({metric, identity})}`)
      const slot = await page.locator('.wallet-balance-slot').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop))
      assert.ok(slot >= 12, 'balance has top breathing room')
      const initial = await bounds('.status-pill')
      const reserved = await page.locator('.status-pill').evaluate((el) => getComputedStyle(el, '::before').content)
      assert.equal(reserved, '"Synced"')
      for (const label of ['Syncing', 'Backup failed', 'Waiting to send', 'Synced']) {
        await page.locator('.status-pill-label [data-aeon-part="item"]').evaluate((el, text) => { el.textContent = text }, label)
        assert.equal((await bounds('.status-pill')).width, initial.width, `status width stable for ${label}`)
      }
      const rowGeometry = await page.locator('.settings-nav-row').evaluateAll((rows) => rows.map((row) => Object.fromEntries(['label', 'leading', 'trailing'].map((part) => { const r = row.querySelector(`[data-aeon-part="${part}"]`).getBoundingClientRect(); return [part, { x: r.x, y: r.y, height: r.height }] }))))
      assert.equal(rowGeometry[0].label.x, rowGeometry[1].label.x, 'settings labels aligned')
      for (const row of rowGeometry) assert.ok(Math.abs(row.leading.y + row.leading.height / 2 - row.trailing.y - row.trailing.height / 2) < 1, 'row adornments centred together')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
      await page.screenshot({ path: path.join(out, `${width}-${theme}.png`), fullPage: true })
      await page.locator('.wallet-hero-identity > span:not([data-aeon-part="avatar"])').evaluate((el) => { el.textContent = '$averylongprofilename' })
      const longAvatar = await bounds('.profile-avatar')
      assert.equal(longAvatar.width, avatar.width, 'long profile never stretches or shrinks avatar')
      assert.equal(longAvatar.height, avatar.height)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long profile fits the viewport')
      console.log(`${width}px ${theme}: avatar ${avatar.width}px, status ${initial.width}px; geometry passed`)
      const upstream = await page.evaluate(() => {
        const row = document.createElement('button')
        row.className = 'aeonListRow__root'
        row.innerHTML = '<span class="aeonListRow__label">No icon</span><span class="aeonListRow__trailing">›</span>'
        document.body.append(row)
        const columns = [...row.children].map((el) => getComputedStyle(el).gridColumnStart)
        row.remove()
        return columns
      })
      assert.deepEqual(upstream, ['2', '3'], 'Aeon rows retain their columns when the leading slot is absent')
      await page.close()
    }
  }
  console.log(`Screenshots: ${out}`)
} finally {
  await browser.close()
}
