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
      {
        find: /^events$/,
        replacement: path.resolve(__dirname, 'node_modules/events/events.js'),
      },
      {
        find: /^buffer$/,
        replacement: path.resolve(__dirname, 'node_modules/buffer/index.js'),
      },
    ],
  },
  optimizeDeps: {
    ...aeonUiOptimizeDeps(),
    include: [
      ...(aeonUiOptimizeDeps().include ?? []),
      'buffer',
      'events',
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'https://brc-cloud.bcryderman.workers.dev',
        changeOrigin: true,
        secure: true,
      },
      '/.well-known': {
        target: 'https://brc-cloud.bcryderman.workers.dev',
        changeOrigin: true,
        secure: true,
      },
      // Toolbox Arcade client sends xdeployment-id; browser CORS blocks it direct.
      '/arcade-v2': {
        target: 'https://arcade-v2-us-1.bsvblockchain.tech',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/arcade-v2/, ''),
      },
      '/arcade-v2-testnet': {
        target: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/arcade-v2-testnet/, ''),
      },
    },
    watch: {
      // packaging writes here — don't restart Vite while launch:mac runs
      ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**'],
    },
  },
})
