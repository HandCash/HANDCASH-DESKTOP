import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Wallet tests share durable caches and provider fallbacks. Fork isolation
    // plus a default offline fetch keep one file from poisoning another.
    pool: 'forks',
    fileParallelism: true,
  },
})
