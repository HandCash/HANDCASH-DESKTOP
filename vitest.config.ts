import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aeonUiViteAliases } from 'aeon-ui-engine/vite'
import { configDefaults, defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))
const brcCloudOverlay = path.resolve(
  root,
  '../BRC-CLOUD/src/marketOverlayProtocol.js',
)
/** Overlay contract tests import the sibling BRC-CLOUD checkout. Skip in CI. */
const siblingMarketTests = [
  'src/wallet/marketOfferParity.test.ts',
  'src/wallet/marketProvenancePublish.test.ts',
]

export default defineConfig({
  resolve: {
    alias: [
      ...aeonUiViteAliases(),
      { find: '@handcash/wallet-engine', replacement: path.resolve(root, 'packages/wallet-engine/src/index.ts') },
      { find: '@aeon-ui/tree', replacement: path.resolve(root, 'vendor/aeon-ui-engine/packages/tree/src/index.ts') },
      { find: '@aeon-ui/core', replacement: path.resolve(root, 'vendor/aeon-ui-engine/packages/core/src/index.ts') },
      { find: '@aeon-ui/primitives', replacement: path.resolve(root, 'vendor/aeon-ui-engine/packages/primitives/src/index.ts') },
      { find: '@aeon-ui/react', replacement: path.resolve(root, 'vendor/aeon-ui-engine/packages/react/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'src/**/*.live.test.ts',
      ...(fs.existsSync(brcCloudOverlay) ? [] : siblingMarketTests),
    ],
    setupFiles: ['./vitest.setup.ts'],
    // Wallet tests share durable caches and provider fallbacks. Fork isolation
    // plus a default offline fetch keep one file from poisoning another.
    pool: 'forks',
    fileParallelism: true,
  },
})
