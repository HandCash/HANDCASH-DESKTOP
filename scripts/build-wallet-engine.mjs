import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(root, 'packages/wallet-engine/src/index.ts')],
  outfile: path.join(root, 'packages/wallet-engine/dist/index.mjs'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'linked',
  external: [
    '@bsv/sdk',
    '@bsv/sdk/*',
    '@noble/hashes',
    '@noble/hashes/*',
    'hash-wasm',
    'hash-wasm/*',
    'idb',
  ],
})

console.info('[wallet-engine] built packages/wallet-engine/dist/index.mjs')
