import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
  },
})
