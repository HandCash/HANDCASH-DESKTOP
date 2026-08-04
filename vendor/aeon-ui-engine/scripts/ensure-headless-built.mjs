#!/usr/bin/env node
/**
 * Build @aeon-ui/core, primitives, and react when dist/ is missing.
 * Consumers: add to prebuild — `node path/to/AeonUI/scripts/ensure-headless-built.mjs`
 * Override repo root: AEON_UI_ROOT=/path/to/AeonUI
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const aeonRoot = process.env.AEON_UI_ROOT
  ? path.resolve(process.env.AEON_UI_ROOT)
  : path.resolve(scriptDir, '..')

const marker = path.join(aeonRoot, 'packages/react/dist/index.js')

if (existsSync(marker)) {
  console.log('[aeon-ui] headless packages already built')
  process.exit(0)
}

console.log('[aeon-ui] building core, primitives, react…')
execSync('pnpm run build:headless', { cwd: aeonRoot, stdio: 'inherit' })
