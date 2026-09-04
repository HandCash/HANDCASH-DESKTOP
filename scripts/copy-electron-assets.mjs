import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'electron', 'assets')
const dest = path.join(root, 'dist-electron', 'assets')

fs.mkdirSync(dest, { recursive: true })
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name))
}
console.log(`  • copied electron assets → dist-electron/assets (${fs.readdirSync(dest).join(', ')})`)
