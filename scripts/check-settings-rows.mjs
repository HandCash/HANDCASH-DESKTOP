// Renders the real Settings row components with the real stylesheets at phone width
// and reports where each primitive lands. Fails if label, description and control
// do not sit in their own columns on a Settings sub-screen.
//   node scripts/check-settings-rows.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panda = await fs.realpath(path.join(root, 'node_modules/@aeon-ui/panda'))

const sheets = [
  path.join(panda, 'styled-system/styles.css'),
  path.join(panda, 'theme-runtime.css'),
  path.join(panda, 'src/theme/chrome.css'),
  path.join(panda, 'src/theme/consumer-shell.css'),
  path.join(root, 'src/styles/handcash.css'),
  path.join(root, 'src/styles/layout-compact.css'),
]
const css = (await Promise.all(sheets.map((name) => fs.readFile(name, 'utf8')))).join('\n')

const entry = `
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { SettingsControlRow } from './src/components/settings/SettingsControlRow'
import { SettingsNavRow } from './src/components/settings/SettingsNavRow'
import { SettingsSection } from './src/components/settings/SettingsSection'
const icon = h('svg', { width: 20, height: 20 })
const button = (text) => h('button', { className: 'btn btn-ghost btn-compact' }, text)
const list = (...rows) => h('ul', { className: 'settings-list' }, ...rows)
const rows = () => [
  h(SettingsControlRow, { key: 'a', label: 'Last upload', icon, description: '10/6/2026, 9:49:06 PM' }, button('CHECK')),
  h(SettingsControlRow, { key: 'b', label: 'Restore from cloud', icon, description: 'Merge the cloud copy in; nothing on this device is removed' }, button('RESTORE')),
  h(SettingsControlRow, { key: 'c', label: 'Rebuild from cloud', icon, description: 'This device has 3 actions the cloud copy lacks. Back up first.' }, button('REBUILD')),
  h(SettingsControlRow, { key: 'd', label: 'No icon row', description: 'Description beside no icon' }, button('RESTORE')),
  h(SettingsControlRow, { key: 'e', label: 'HandCash password', icon, description: 'Unlock this wallet with a password' }, h('div', { className: 'actions' }, button('CHANGE'), button('REMOVE'))),
  h(SettingsControlRow, { key: 'f', label: 'Heal wallet UTXOs', icon, description: 'Recover spendable outputs from wallet history' }, h('span', { className: 'status-pill' }, 'Ready'), button('HEAL')),
  h(SettingsNavRow, { key: 'g', label: 'Fingerprint / device lock', icon, description: 'On - hardware sealed', onClick() {} }),
]
const panel = (scope) =>
  h('div', { className: 'nav-section-body settings-scroll', 'data-aeon-scope': scope, id: scope },
    h('p', { className: 'settings-hint' }, 'Hint above the first group.'),
    h(SettingsSection, { title: 'Cloud copy', part: 'cloud' }, list(...rows())),
    h(SettingsSection, { title: 'Backup file', part: 'file' }, list(...rows())))
// 'panel-nobody-listed' proves a new sub-panel gets the row layout without being named in CSS.
window.fixtureHtml = ['settings', 'history-backup', 'settings-unlock', 'device-handoff', 'handcash-recovery', 'legacy-import', 'chart-apps', 'dev-keys', 'log-viewer', 'panel-nobody-listed']
  .map((scope) => renderToStaticMarkup(panel(scope))).join('')
`
const { outputFiles } = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  nodePaths: [path.join(root, 'node_modules')],
  alias: Object.fromEntries(
    ['core', 'primitives', 'react', 'tree'].map((name) => [
      `@aeon-ui/${name}`,
      path.join(panda, `../${name}/src/index.ts`),
    ]),
  ),
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl' },
  logLevel: 'silent',
})

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const failures = []
try {
  for (const width of [320, 360, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent('<html class="layout-compact" data-aeon-mode="dark"><body><main id="app"></main></body></html>')
    await page.addScriptTag({ content: outputFiles[0].text })
    await page.evaluate(() => {
      document.getElementById('app').innerHTML = window.fixtureHtml
    })
    await page.addStyleTag({ content: css })
    const report = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }
      }
      const panels = [...document.querySelectorAll('.settings-scroll')]
      return panels.map((panel) => {
        const groups = [...panel.querySelectorAll(':scope > .settings-group')].map(box)
        return {
          scope: panel.dataset.aeonScope,
          groupGap: groups.length > 1 ? groups[1].top - groups[0].bottom : null,
          hintGap: groups[0].top - box(panel.querySelector('.settings-hint')).bottom,
          overflow: panel.scrollWidth - panel.clientWidth,
          rows: [...panel.querySelector('.settings-list').querySelectorAll('[data-aeon-scope="listRow"][data-aeon-part="root"]')].map((row) => ({
            display: getComputedStyle(row).display,
            root: box(row),
            leading: box(row.querySelector(':scope > [data-aeon-part="leading"]')),
            label: box(row.querySelector(':scope > [data-aeon-part="label"]')),
            description: box(row.querySelector(':scope > [data-aeon-part="description"]')),
            trailing: box(row.querySelector(':scope > [data-aeon-part="trailing"]')),
          })),
        }
      })
    })
    for (const panel of report) {
      const name = `${width}px ${panel.scope}`
      console.log(`${name}: gap between groups ${panel.groupGap}px, hint to group ${panel.hintGap}px, overflow ${panel.overflow}px`)
      for (const row of panel.rows) {
        console.log(`  ${row.display} h=${row.root.bottom - row.root.top} icon=${row.leading?.left ?? '-'} label=${row.label.left} desc=${row.description?.left ?? '-'}/${row.description?.top ?? '-'} labelBottom=${row.label.bottom} ctrl=${row.trailing?.left ?? '-'}-${row.trailing?.right ?? '-'}`)
        if (row.display !== 'grid') failures.push(`${name}: row is ${row.display}, not grid`)
        if (row.description && row.description.left !== row.label.left) failures.push(`${name}: description not under label`)
        if (row.description && row.description.top < row.label.bottom - 1) failures.push(`${name}: description beside label`)
        if (row.trailing && row.trailing.top < (row.description ?? row.label).bottom - 1) failures.push(`${name}: compact control not below text`)
        if (row.trailing && row.trailing.right > row.root.right + 1) failures.push(`${name}: control leaves row`)
        if (row.label.right - row.label.left < 80) failures.push(`${name}: text squeezed`)
      }
      if (panel.overflow > 0) failures.push(`${name}: sideways overflow ${panel.overflow}px`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n${[...new Set(failures)].join('\n')}`)
  process.exit(1)
}
console.log('\nOK')
