#!/usr/bin/env node
/**
 * Bundle the Node bridge (+ optional UI) sidecar for thin native shells.
 * Output: dist-sidecar/ — no Electron binary, no full electron/ main compile.
 */
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist-sidecar')

fs.mkdirSync(outDir, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // Sidecar must not embed Electron; host APIs use dynamic import only on the Electron path.
  external: ['electron', 'electron-log'],
}

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'electron/bridgeSidecar.ts')],
  outfile: path.join(outDir, 'bridgeSidecar.cjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'electron/uiSidecar.ts')],
  outfile: path.join(outDir, 'uiSidecar.cjs'),
})

console.log(`  • sidecar → ${outDir}/bridgeSidecar.cjs + uiSidecar.cjs`)
