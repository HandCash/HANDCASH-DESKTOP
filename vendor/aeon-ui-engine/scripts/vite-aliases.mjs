/**
 * Vite + TypeScript wiring for apps that install `aeon-ui-engine` from npm.
 *
 * @example
 * // vite.config.ts — one call, done
 * import { aeonUiVitePlugin } from 'aeon-ui-engine/vite'
 *
 * export default defineConfig({
 *   plugins: [react(), aeonUiVitePlugin()],
 * })
 *
 * // tsconfig.json — spread the base config
 * {
 *   "extends": "aeon-ui-engine/tsconfig",
 *   "compilerOptions": { "jsx": "react-jsx" }
 * }
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to `aeon-ui-engine/packages` (npm install or monorepo checkout). */
export function resolveAeonPackagesRoot(opts = {}) {
  if (opts.packagesRoot) return path.resolve(opts.packagesRoot)
  if (process.env.AEON_UI_ROOT) {
    return path.join(path.resolve(process.env.AEON_UI_ROOT), 'packages')
  }
  try {
    const require = createRequire(import.meta.url)
    const engineRoot = path.dirname(require.resolve('aeon-ui-engine/package.json'))
    return path.join(engineRoot, 'packages')
  } catch {
    return path.resolve(scriptDir, '../packages')
  }
}

/** Vite `resolve.alias` entries — `@aeon-ui/*` is not published separately. */
export function aeonUiViteAliases(opts = {}) {
  const packages = resolveAeonPackagesRoot(opts)
  const extra = opts.extraAliases ?? []

  return [
    ...extra,
    {
      find: 'aeon-ui-engine/aeon.css',
      replacement: path.join(packages, 'panda/aeon.css'),
    },
    {
      find: '@aeon-ui/panda/styles.css',
      replacement: path.join(packages, 'panda/styled-system/styles.css'),
    },
    {
      find: '@aeon-ui/panda/theme-runtime.css',
      replacement: path.join(packages, 'panda/theme-runtime.css'),
    },
    {
      find: '@aeon-ui/panda/scrollbars.css',
      replacement: path.join(packages, 'panda/src/theme/scrollbars.css'),
    },
    {
      find: '@aeon-ui/panda/chrome.css',
      replacement: path.join(packages, 'panda/src/theme/chrome.css'),
    },
    {
      find: '@aeon-ui/panda/consumer-shell.css',
      replacement: path.join(packages, 'panda/src/theme/consumer-shell.css'),
    },
    {
      find: '@aeon-ui/panda/electron.css',
      replacement: path.join(packages, 'panda/src/theme/electron.css'),
    },
    {
      find: '@aeon-ui/panda/styled-system/css',
      replacement: path.join(packages, 'panda/styled-system/css/index.mjs'),
    },
    {
      find: '@aeon-ui/panda/styled-system/recipes',
      replacement: path.join(packages, 'panda/styled-system/recipes/index.mjs'),
    },
    {
      find: '@aeon-ui/panda/themes',
      replacement: path.join(packages, 'panda/src/theme/index.ts'),
    },
    {
      find: '@aeon-ui/ui/styles.css',
      replacement: path.join(packages, 'ui/src/styles.css'),
    },
    {
      find: '@aeon-ui/surface/surface.css',
      replacement: path.join(packages, 'surface/surface.css'),
    },
    {
      find: '@aeon-ui/core/theme-transition.css',
      replacement: path.join(packages, 'core/theme-transition.css'),
    },
    { find: '@aeon-ui/surface', replacement: path.join(packages, 'surface/src/index.ts') },
    { find: '@aeon-ui/core', replacement: path.join(packages, 'core/src/index.ts') },
    { find: '@aeon-ui/primitives', replacement: path.join(packages, 'primitives/src/index.ts') },
    { find: '@aeon-ui/react', replacement: path.join(packages, 'react/src/index.ts') },
    { find: '@aeon-ui/ui', replacement: path.join(packages, 'ui/src/index.ts') },
    { find: '@aeon-ui/schemas', replacement: path.join(packages, 'schemas/src/index.ts') },
    { find: '@aeon-ui/panda', replacement: path.join(packages, 'panda') },
  ]
}

/** Recommended Vite `optimizeDeps` for Aeon + XState apps. */
export function aeonUiOptimizeDeps(opts = {}) {
  const excludeWorkspace = opts.excludeWorkspace ?? true
  return {
    include: [
      'react',
      'react-dom',
      '@xstate/react',
      'xstate',
      ...(opts.include ?? []),
    ],
    exclude: excludeWorkspace
      ? [
          '@aeon-ui/core',
          '@aeon-ui/primitives',
          '@aeon-ui/react',
          '@aeon-ui/ui',
          '@aeon-ui/panda/styled-system/css',
          '@aeon-ui/panda/styled-system/recipes',
          ...(opts.exclude ?? []),
        ]
      : (opts.exclude ?? []),
  }
}

/**
 * `compilerOptions.paths` fragment for a consumer tsconfig.
 * Paths are relative to the app tsconfig file location.
 */
export function aeonUiTsconfigPaths(opts = {}) {
  const prefix = opts.prefix ?? '../node_modules/aeon-ui-engine/packages'
  return {
    '@aeon-ui/core': [`${prefix}/core/src/index.ts`],
    '@aeon-ui/primitives': [`${prefix}/primitives/src/index.ts`],
    '@aeon-ui/react': [`${prefix}/react/src/index.ts`],
    '@aeon-ui/ui': [`${prefix}/ui/src/index.ts`],
    '@aeon-ui/surface': [`${prefix}/surface/src/index.ts`],
    '@aeon-ui/panda/styled-system/css': [`${prefix}/panda/styled-system/css/index.d.ts`],
    '@aeon-ui/panda/styled-system/recipes': [`${prefix}/panda/styled-system/recipes/index.d.ts`],
  }
}

/**
 * All-in-one Vite plugin — aliases + optimizeDeps in one call.
 *
 * @example
 * import { aeonUiVitePlugin } from 'aeon-ui-engine/vite'
 *
 * export default defineConfig({
 *   plugins: [react(), aeonUiVitePlugin()],
 * })
 */
export function aeonUiVitePlugin(opts = {}) {
  const alias = aeonUiViteAliases(opts)
  const optimizeDeps = aeonUiOptimizeDeps(opts)

  return {
    name: 'aeon-ui',
    enforce: 'pre',
    config(userConfig) {
      return {
        resolve: {
          alias: [...(userConfig.resolve?.alias ?? []), ...alias],
        },
        optimizeDeps: {
          ...userConfig.optimizeDeps,
          ...optimizeDeps,
          include: [
            ...(optimizeDeps.include ?? []),
            ...(userConfig.optimizeDeps?.include ?? []),
          ],
          exclude: [
            ...(optimizeDeps.exclude ?? []),
            ...(userConfig.optimizeDeps?.exclude ?? []),
          ],
        },
      }
    },
  }
}
