#!/usr/bin/env node
/**
 * Real-app check for the Settings History / Unlock rows: real Electron main,
 * preload and renderer, on a throwaway profile and a brand-new local wallet.
 * The renderer comes from a `vite build` folder (argv[2]), answered through
 * Playwright routing so no dev server is needed and nothing listens on :5173.
 */
import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const distDir = path.resolve(process.argv[2] ?? 'dist')
const shotDir = process.argv[3] ? path.resolve(process.argv[3]) : null
const ORIGIN = 'http://localhost:5173'
const PASSWORD = 'throwaway-check-4821'
const WIDTHS = [320, 360, 430, 720, 1100]
const MIN_TEXT_WIDTH = 80

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Visible button and link text, for the log and for knowing where we are. */
const visibleButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button, a[role="button"], [role="tab"], [role="menuitem"]')]
      .filter((el) => {
        const box = el.getBoundingClientRect()
        return box.width > 0 && box.height > 0
      })
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean),
  )

async function clickButton(page, pattern) {
  const target = page.getByRole('button', { name: pattern }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  return true
}

/** Walk onboarding with a brand-new local wallet until the dashboard shows. */
async function createWallet(page, log) {
  for (let step = 0; step < 40; step += 1) {
    const inSettingsReach = await page.locator('[data-aeon-scope="auth"], .auth-screen').count()
    if (!inSettingsReach) return true
    const buttons = await visibleButtons(page)
    log(`onboarding step ${step}: ${buttons.join(' | ').slice(0, 200)}`)

    const passwords = page.locator('input[type="password"]:visible')
    const count = await passwords.count()
    for (let i = 0; i < count; i += 1) {
      const field = passwords.nth(i)
      if (!(await field.inputValue())) await field.fill(PASSWORD)
    }
    const boxes = page.locator('input[type="checkbox"]:visible')
    for (let i = 0; i < (await boxes.count()); i += 1) {
      await boxes.nth(i).check().catch(() => {})
    }

    const advanced =
      (await clickButton(page, /^Create new wallet$/)) ||
      (await clickButton(page, /^Create( wallet)?$/)) ||
      (await clickButton(page, /^Continue$/)) ||
      (await clickButton(page, /^(Skip|Not now|Maybe later|Later)\b/)) ||
      (await clickButton(page, /^(Done|Finish|Get started|Enter wallet|Open wallet)\b/))
    await sleep(advanced ? 1200 : 2000)
  }
  return false
}

const measure = (page, scope) =>
  page.evaluate((scopeName) => {
    const panel = document.querySelector(`[data-aeon-scope="${scopeName}"]`)
    if (!panel) return null
    const part = (root, name) => {
      const el = root.querySelector(`:scope > [data-aeon-part="${name}"]`)
      if (!el) return null
      const box = el.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, text: el.innerText.trim() }
    }
    const rows = [...panel.querySelectorAll('[data-aeon-scope="listRow"][data-aeon-part="root"]')].map((root) => {
      const box = root.getBoundingClientRect()
      return {
        display: getComputedStyle(root).display,
        height: Math.round(box.height),
        left: box.left,
        right: box.right,
        label: part(root, 'label'),
        description: part(root, 'description'),
        trailing: part(root, 'trailing'),
      }
    })
    return {
      compact: document.documentElement.classList.contains('layout-compact'),
      overflow: Math.max(0, Math.round(panel.scrollWidth - panel.clientWidth)),
      rows,
    }
  }, scope)

function judge(name, panel, failures, log) {
  if (!panel) {
    failures.push(`${name}: panel not on screen`)
    return
  }
  if (panel.rows.length === 0) failures.push(`${name}: no rows found`)
  log(`${name}: compact=${panel.compact} overflow=${panel.overflow}px rows=${panel.rows.length}`)
  for (const row of panel.rows) {
    const label = row.label?.text ?? '(no label)'
    const desc = row.description
    const ctrl = row.trailing
    log(
      `  ${row.display} h=${row.height} "${label.slice(0, 26)}"` +
        ` desc=${desc ? `${Math.round(desc.left)}/${Math.round(desc.top)}` : '-'}` +
        ` labelBottom=${Math.round(row.label?.bottom ?? 0)}` +
        ` ctrl=${ctrl ? `${Math.round(ctrl.left)}-${Math.round(ctrl.right)}` : '-'}`,
    )
    if (row.display !== 'grid') failures.push(`${name} "${label}": row is ${row.display}, not grid`)
    if (desc && row.label && desc.top < row.label.bottom - 1) {
      failures.push(`${name} "${label}": description runs into the label`)
    }
    for (const text of [row.label, desc]) {
      if (ctrl && text && ctrl.left < text.right - 1 && ctrl.top < text.bottom - 1 && ctrl.bottom > text.top + 1) {
        failures.push(`${name} "${label}": control overlaps "${text.text.slice(0, 24)}"`)
      }
    }
    if (ctrl && ctrl.right > row.right + 1) failures.push(`${name} "${label}": control leaves the row`)
    if (row.label && row.label.right - row.label.left < MIN_TEXT_WIDTH) {
      failures.push(`${name} "${label}": text squeezed to ${Math.round(row.label.right - row.label.left)}px`)
    }
  }
  if (panel.overflow > 0) failures.push(`${name}: sideways overflow ${panel.overflow}px`)
}

async function openSetting(page, label, scope, log) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await page.locator(`[data-aeon-scope="${scope}"]`).count()) return true
    const row = page.locator('[data-aeon-scope="listRow"][data-aeon-part="root"]', { hasText: label }).first()
    if (await row.isVisible().catch(() => false)) {
      await row.click()
      await sleep(800)
      continue
    }
    const settings = page.getByRole('button', { name: /^Settings$/ }).first()
    const tab = page.getByRole('tab', { name: /^Settings$/ }).first()
    if (await settings.isVisible().catch(() => false)) await settings.click()
    else if (await tab.isVisible().catch(() => false)) await tab.click()
    else log(`no Settings button; visible: ${(await visibleButtons(page)).join(' | ').slice(0, 300)}`)
    await sleep(800)
  }
  return (await page.locator(`[data-aeon-scope="${scope}"]`).count()) > 0
}

const profileDir = await mkdtemp(path.join(os.tmpdir(), 'handcash-rows-'))
const failures = []
const log = (line) => console.log(line)
let app
try {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
  app = await electron.launch({
    args: ['.', `--user-data-dir=${profileDir}`],
    env: {
      ...env,
      HOME: profileDir,
      XDG_CONFIG_HOME: profileDir,
      XDG_DATA_HOME: profileDir,
      HANDCASH_E2E: '1',
    },
  })
  const page = await app.firstWindow()
  await page.context().route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url())
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    const file = path.join(distDir, relative)
    if (!file.startsWith(distDir)) return route.fulfill({ status: 403 })
    try {
      const body = await readFile(file)
      return route.fulfill({
        status: 200,
        body,
        contentType: MIME[path.extname(file)] ?? 'application/octet-stream',
      })
    } catch {
      return route.fulfill({ status: 404 })
    }
  })
  await page.goto(`${ORIGIN}/`)
  await page.locator('#root').waitFor()
  await sleep(2500)
  log(`loaded ${page.url()}`)

  const loadedFix = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => rule.cssText?.includes('settings-unlock') && rule.cssText.includes('listRow'))
      } catch {
        return false
      }
    }),
  )
  log(`built stylesheet has the new scopes: ${loadedFix}`)

  if (!(await createWallet(page, log))) throw new Error('Onboarding did not reach the wallet')
  log(`wallet open; visible: ${(await visibleButtons(page)).join(' | ').slice(0, 300)}`)

  if (shotDir) await mkdir(shotDir, { recursive: true })
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 860 })
    await sleep(600)
    for (const [label, scope] of [
      ['History', 'history-backup'],
      ['Unlock', 'settings-unlock'],
    ]) {
      const opened = await openSetting(page, label, scope, log)
      const name = `${width}px ${scope}`
      if (!opened) {
        failures.push(`${name}: could not open it`)
        continue
      }
      await sleep(500)
      judge(name, await measure(page, scope), failures, log)
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `${width}-${scope}.png`) })
      const back = page.getByRole('button', { name: /^(Back|Settings)$/ }).first()
      if (await back.isVisible().catch(() => false)) await back.click()
      await sleep(500)
    }
  }
} catch (err) {
  failures.push(`run stopped: ${err.message.split('\n')[0]}`)
} finally {
  await app?.close().catch(() => {})
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

if (failures.length) {
  console.log(`\nFAILED (${failures.length})`)
  for (const failure of failures) console.log(`  ${failure}`)
  process.exit(1)
}
console.log('\nOK')
