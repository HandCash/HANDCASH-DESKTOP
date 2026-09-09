import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
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
