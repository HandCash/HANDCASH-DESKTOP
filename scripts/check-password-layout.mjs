// Focused layout fixture: real Aeon password fields/buttons, product CSS,
// and the existing Settings scope/parts. No wallet or vault is created.
import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = process.cwd()
const panda = await fs.realpath('node_modules/@aeon-ui/panda')
const css = (await Promise.all([
  path.join(panda, 'styled-system/styles.css'),
  path.join(panda, 'theme-runtime.css'),
  path.join(panda, 'src/theme/chrome.css'),
  path.join(panda, 'src/theme/consumer-shell.css'),
  'src/styles/handcash.css', 'src/styles/layout-compact.css',
].map((file) => fs.readFile(file, 'utf8')))).join('\n')
const entry = `
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@aeon-ui/react'
import { PasswordField } from './src/components/PasswordField'
window.markup = (state, error) => renderToStaticMarkup(
  h('div', { className: 'settings-detail settings-detail-compact settings-scroll',
    'data-aeon-scope': 'settings-unlock', 'data-aeon-state': state },
    h('div', { className: 'confirm-password-copy' },
      h('h3', { className: 'confirm-password-title' }, 'Add a HandCash password'),
      h('p', { className: 'confirm-password-lede' }, 'Optional backup unlock when biometrics aren’t available. Confirm with this device first.')),
    h('form', { className: 'settings-form settings-form-compact', 'data-aeon-part': 'factor-form', 'data-aeon-state': 'idle' },
      h(PasswordField, { id: 'password', label: 'HandCash password' }),
      h(PasswordField, { id: 'confirm', label: 'Confirm password' }),
      error ? h('p', { className: 'error', role: 'alert' }, 'Passwords do not match') : null,
      h('div', { className: 'actions' },
        h(Button.Root, { variant: 'solid', className: 'btn btn-primary' }, h(Button.Label, null, 'Save password')),
        h(Button.Root, { variant: 'ghost', className: 'btn btn-ghost' }, h(Button.Label, null, 'Back'))))))
`
const { outputFiles } = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  alias: Object.fromEntries(['core', 'primitives', 'react', 'tree'].map((name) =>
    ['@aeon-ui/' + name, path.join(panda, '../' + name + '/src/index.ts')])),
  define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl' },
  logLevel: 'silent',
})
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  for (const width of [320, 430, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent('<html data-aeon-mode="dark"><body><div id="balance">Your balance</div><main id="fixture" style="display:grid;height:750px;padding:16px"></main></body></html>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: outputFiles[0].text })
    for (const state of ['set-password', 'change-password']) {
      for (const error of [false, true]) {
        await page.evaluate(({ state, error }) => {
          document.querySelector('#fixture').innerHTML = window.markup(state, error)
        }, { state, error })
        const metrics = await page.evaluate(() => {
          const panel = document.querySelector('[data-aeon-scope="settings-unlock"]')
          const form = panel.querySelector('form')
          const bounds = form.getBoundingClientRect()
          const inputs = [...form.querySelectorAll('input')]
          const buttons = [...form.querySelector('.actions').querySelectorAll('button')]
          return {
            height: bounds.height,
            overflow: panel.scrollWidth > panel.clientWidth,
            controlsVisible: [...inputs, ...buttons, document.querySelector('#balance')].every((el) => {
              const box = el.getBoundingClientRect()
              return box.width > 0 && box.height > 0 && box.bottom < 900
            }),
          }
        })
        if (metrics.height > 350 || metrics.overflow || !metrics.controlsVisible) {
          throw new Error(JSON.stringify({ width, state, error, ...metrics }))
        }
        console.log(width, state, error ? 'error' : 'idle', metrics.height + 'px: OK')
      }
    }
    await page.close()
  }
} finally { await browser.close() }
