import { defineConfig } from 'vitest/config'

/**
 * Real mainnet broadcast + receive. Never used by `npm test`.
 *
 *   HANDCASH_LIVE_TX=print npm run test:live-tx
 *   HANDCASH_LIVE_TX=1 npm run test:live-tx
 */
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('live'),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    setupFiles: ['src/wallet/headlessDom.setup.ts'],
    testTimeout: 25 * 60_000,
    hookTimeout: 25 * 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ['verbose'],
  },
})
