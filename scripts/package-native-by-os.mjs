#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script =
  process.platform === 'darwin'
    ? 'package-native-mac.mjs'
    : process.platform === 'win32'
      ? 'package-native-win.mjs'
      : process.platform === 'linux'
        ? 'package-native-linux.mjs'
        : null

if (!script) {
  console.error(`no native package script for platform ${process.platform}`)
  process.exit(1)
}

const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
