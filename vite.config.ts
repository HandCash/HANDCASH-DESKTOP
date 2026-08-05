import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { aeonUiOptimizeDeps, aeonUiViteAliases } from 'aeon-ui-engine/vite'
import fs from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string }

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [
      ...aeonUiViteAliases(),
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  optimizeDeps: aeonUiOptimizeDeps(),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // packaging writes here — don't restart Vite while launch:mac runs
      ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**'],
    },
  },
})
