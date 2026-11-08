#!/usr/bin/env node
// Product chrome geometry fixture: no wallet, credentials or network.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const css = (await Promise.all([
  'vendor/aeon-ui-engine/packages/panda/styled-system/styles.css',
  'vendor/aeon-ui-engine/packages/panda/theme-runtime.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/chrome.css',
  'vendor/aeon-ui-engine/packages/panda/src/theme/consumer-shell.css',
  'src/styles/handcash.css', 'src/styles/layout-compact.css',
].map(p => fs.readFile(p, 'utf8')))).join('\n')
const { outputFiles } = await build({
  stdin: { contents: "import { applyBrandPalette } from '@aeon-ui/core'; import { paletteForMode } from './src/wallet/handcashTheme'; window.theme = mode => applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' });", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser',
})
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-hierarchy-'))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  for (const width of [360, 430, 1440]) for (const mode of ['dark', 'light']) {
    const compact = width < 600
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent(`<html class="${compact ? 'layout-compact' : ''}"><body><div class="dashboard" style="height:840px"><main class="dashboard-main"><section class="panel wallet-hero" data-aeon-scope="wallet-hero" data-aeon-shell="${compact ? 'compact' : 'wide'}"><div class="connected-panel-head wallet-hero-head"><div class="wallet-nav-actions-pill wallet-hero-metric"><button class="fiat-currency-trigger"><span class="wallet-hero-title"><span class="wallet-hero-title-full">Balance</span><span class="wallet-hero-title-approx">~</span></span><span class="wallet-hero-metric-amount">$123.45</span></button></div><div class="wallet-nav-actions-pill wallet-hero-identity-chrome"><div class="wallet-account-menu"><div class="wallet-hero-identity-row"><button class="wallet-hero-identity"><span class="profile-avatar">A</span><span>$alice</span></button></div></div></div></div><div class="wallet-hero-main"><div class="wallet-balance-block"><div class="wallet-balance-slot"><button class="wallet-balance">1.2345 BSV</button></div></div></div></section><section class="panel wallet-nav-shell"><div class="wallet-nav-stage"><header class="connected-panel-head">Activity</header><p>No recent activity</p></div></section></main><aside class="dashboard-side"><section class="panel history-panel"><header class="connected-panel-head">History</header><p>No recent payments</p></section></aside></div></body></html>`)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: outputFiles[0].text })
    await page.evaluate(mode => window.theme(mode), mode)
    const box = selector => page.locator(selector).first().boundingBox()
    const head = await box('.wallet-hero-head')
    const identity = await box('.wallet-hero-identity-chrome')
    const metric = await box('.wallet-hero-metric')
    if (!compact) assert.ok(Math.abs(identity.x + identity.width - head.x - head.width) < 2, 'desktop identity right aligned')
    else assert.ok(Math.abs(identity.x - metric.x - metric.width) < 2, 'compact joined bar unchanged')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
    await page.locator('.fiat-currency-trigger').focus()
    assert.equal(await page.locator('.fiat-currency-trigger').evaluate(el => el.matches(':focus-visible')), true)
    await page.screenshot({ path: path.join(out, `${width}-${mode}.png`), fullPage: true })
    await page.locator('.wallet-hero-identity span:last-child').evaluate(el => { el.textContent = '$averylongprofilename' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long identity fits')
    console.log(`${width}px ${mode}: passed`)
    await page.close()
  }
  console.log(`Fixture screenshots: ${out}`)
} finally { await browser.close() }
