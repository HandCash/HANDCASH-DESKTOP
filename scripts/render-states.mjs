#!/usr/bin/env node
/**
 * Statechart render harness. Each fixture in tests/render/states/*.json is one
 * component in one machine state, as data: mock wallet rows plus the snapshot
 * (value + context) each machine starts in. tests/render/mocks/ replaces the
 * matching src/ modules; tests/render/xstateReact.ts restores the snapshot
 * (no events run) and mirrors live state to window.__renderStates.
 * Renders through Vite + Playwright chromium at 360 / 430 / 1440 px in dark and
 * light; fails on render errors, horizontal overflow, or a machine not in its
 * declared state. Writes <shot>.png and <shot>.state.json (the observed state).
 *
 *   npm run ui:render
 *   npm run ui:render -- --fixture identity/claimed --out /tmp/shots --widths 430
 *
 * No wallet, storage or network: only localhost and the Google Fonts the app
 * itself loads are reachable from the page.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src') + path.sep
const mocksDir = path.join(root, 'tests', 'render', 'mocks')
const xstateShim = path.join(root, 'tests', 'render', 'xstateReact.ts')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const only = arg('fixture', '')
const widths = arg('widths', '360,430,1440').split(',').map(Number)
const modes = arg('modes', 'dark,light').split(',')
const outDir = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'hc-render-'))))
fs.mkdirSync(outDir, { recursive: true })

/** Point src/ imports at tests/render/mocks/ twins, and @xstate/react at the replay shim. */
const mockPlugin = {
  name: 'hc-render-mocks',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer) return null
    if (source === '@xstate/react') {
      return importer === xstateShim ? null : xstateShim
    }
    if (!source.startsWith('.') && !source.startsWith('@/')) return null
    if (importer.startsWith(mocksDir)) return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    const id = resolved?.id?.split('?')[0]
    if (!id || !id.startsWith(srcDir)) return null
    const rel = path.relative(srcDir, id).replace(/\.tsx?$/, '')
    for (const ext of ['.ts', '.tsx']) {
      const mock = path.join(mocksDir, rel + ext)
      if (fs.existsSync(mock)) return mock
    }
    return null
  },
}

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  clearScreen: false,
  plugins: [mockPlugin],
  server: {
    port: 0,
    strictPort: false,
    hmr: false,
    proxy: {},
    fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
  },
})
await server.listen()
const base = server.resolvedUrls.local[0].replace(/\/$/, '')

const statesDir = path.join(root, 'tests', 'render', 'states')
const declared = {}
for (const file of fs.readdirSync(statesDir).filter((f) => f.endsWith('.json'))) {
  Object.assign(declared, JSON.parse(fs.readFileSync(path.join(statesDir, file), 'utf8')).fixtures)
}
const names = Object.keys(declared).filter((name) => name.startsWith(only))
if (names.length === 0) {
  console.error(`No fixture matches "${only}". Known: ${Object.keys(declared).join(', ')}`)
  await server.close()
  process.exit(1)
}

const browser = await chromium.launch()
const failures = []
let shots = 0
try {
  for (const name of names) {
    for (const mode of modes) {
      for (const width of widths) {
        const height = width < 900 ? 860 : 900
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme: mode,
          deviceScaleFactor: 1,
        })
        const errors = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') errors.push(msg.text())
        })
        await page.route('**/*', (route) => {
          const host = new URL(route.request().url()).hostname
          const allowed =
            host === '127.0.0.1' ||
            host === 'localhost' ||
            host === 'fonts.googleapis.com' ||
            host === 'fonts.gstatic.com'
          return allowed ? route.continue() : route.abort()
        })
        const label = `${name} ${mode} ${width}`
        try {
          await page.goto(`${base}/tests/render/index.html?fixture=${encodeURIComponent(name)}&mode=${mode}`)
          await page.waitForFunction(
            () => document.documentElement.dataset.renderReady || document.documentElement.dataset.renderError,
            null,
            { timeout: 30_000 },
          )
          await page.evaluate(() => document.fonts.ready)
          const state = await page.evaluate(() => {
            const el = document.documentElement
            const scroller = document.querySelector('.nav-section-scroll-body')
            const overflow = [...document.querySelectorAll('#root *')]
              .filter((node) => {
                const r = node.getBoundingClientRect()
                return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)
              })
              .slice(0, 5)
              .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`)
            return {
              error: el.dataset.renderError ?? null,
              compact: el.classList.contains('layout-compact'),
              docOverflow: el.scrollWidth > el.clientWidth + 1,
              scrollOverflow: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : false,
              overflow,
            }
          })
          const observed = await page.evaluate(() => window.__renderStates ?? {})
          const problems = []
          for (const [id, want] of Object.entries(declared[name].machines ?? {})) {
            const got = observed[id]
            if (!got) problems.push(`machine ${id} never rendered`)
            else if (JSON.stringify(got.value) !== JSON.stringify(want.value))
              problems.push(`machine ${id} in ${JSON.stringify(got.value)}, declared ${JSON.stringify(want.value)}`)
          }
          if (state.error) problems.push(`render error: ${state.error}`)
          if (state.docOverflow || state.scrollOverflow || state.overflow.length)
            problems.push(`horizontal overflow ${state.overflow.join(', ')}`)
          const pageErrors = errors.filter((e) => !/net::ERR_FAILED|Failed to load resource/.test(e))
          if (pageErrors.length) problems.push(`console: ${pageErrors.slice(0, 3).join(' | ')}`)
          // Tall scroll body: capture its full content, not only the viewport.
          const fullHeight = await page.evaluate(() => {
            const scroller = document.querySelector('.nav-section-scroll-body')
            if (!scroller) return 0
            return Math.ceil(scroller.scrollHeight - scroller.clientHeight)
          })
          if (fullHeight > 0) await page.setViewportSize({ width, height: height + fullHeight })
          const file = path.join(outDir, `${name.replace(/\//g, '--')}--${mode}--${width}.png`)
          await page.screenshot({ path: file, animations: 'disabled' })
          fs.writeFileSync(
            file.replace(/\.png$/, '.state.json'),
            JSON.stringify({ fixture: name, mode, width, declared: declared[name], observed }, null, 2) + '\n',
          )
          shots++
          console.log(`${problems.length ? 'FAIL' : 'ok  '} ${label}${state.compact ? ' (compact)' : ''}  ${file}`)
          for (const p of problems) {
            console.log(`       ${p}`)
            failures.push(`${label}: ${p}`)
          }
        } catch (err) {
          failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
          console.log(`FAIL ${label}  ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          await page.close()
        }
      }
    }
  }
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n${shots} screenshot(s) in ${outDir}`)
if (failures.length) {
  console.error(`${failures.length} problem(s)`)
  process.exit(1)
}
