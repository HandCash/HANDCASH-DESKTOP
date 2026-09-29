import { defineConfig, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import { aeonUiOptimizeDeps, aeonUiViteAliases } from 'aeon-ui-engine/vite'
import fs from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string }

/**
 * `@bsv/verifast` glue (page and worker) loads `bdk-core.wasm` from its own
 * chunk directory by that exact name, so that one asset keeps it unhashed.
 */
const assetFileNames = (asset: Rollup.PreRenderedAsset): string =>
  asset.names.includes('bdk-core.wasm')
    ? 'assets/[name][extname]'
    : 'assets/[name]-[hash][extname]'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
    rollupOptions: { output: { assetFileNames } },
  },
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [
      ...aeonUiViteAliases(),
      {
        find: '@aeon-ui/tree',
        replacement: path.resolve(__dirname, 'vendor/aeon-ui-engine/packages/tree/src/index.ts'),
      },
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
    exclude: [...(aeonUiOptimizeDeps().exclude ?? []), '@bsv/verifast'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { output: { assetFileNames } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `secure: false`: Node does not use the macOS keychain. Captive SSL
      // inspection (IKEA FWSSL, etc.) presents a self-signed chain and would
      // otherwise 502 Arcade GET /tx during list/buy.
      '/v1': {
        target: 'https://brc-cloud.bcryderman.workers.dev',
        changeOrigin: true,
        secure: false,
      },
      '/.well-known': {
        target: 'https://brc-cloud.bcryderman.workers.dev',
        changeOrigin: true,
        secure: false,
      },
      // Toolbox Arcade client sends xdeployment-id; browser CORS blocks it direct.
      '/arcade-v2': {
        target: 'https://arcade-v2-us-1.bsvblockchain.tech',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/arcade-v2/, ''),
      },
      '/arcade-v2-testnet': {
        target: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/arcade-v2-testnet/, ''),
      },
    },
    watch: {
      // packaging writes here — don't restart Vite while launch:mac runs
      ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**'],
    },
  },
})
