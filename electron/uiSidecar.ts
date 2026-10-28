/**
 * Optional packaged-UI process for thin native shells.
 * Serves dist/ on http://localhost:5173 when HANDCASH_UI_ROOT is set.
 * Kept separate from bridgeSidecar so hosts can start it without Electron.
 */
import { startPackagedUiServer, stopPackagedUiServer } from './packagedUiServer.js'

const uiRootEnv = process.env.HANDCASH_UI_ROOT
if (!uiRootEnv) {
  console.error('uiSidecar: set HANDCASH_UI_ROOT to the renderer dist directory')
  process.exit(1)
}
const root: string = uiRootEnv

const log = {
  info: (...args: unknown[]) => console.log('[ui-sidecar]', ...args),
  warn: (...args: unknown[]) => console.warn('[ui-sidecar]', ...args),
  error: (...args: unknown[]) => console.error('[ui-sidecar]', ...args),
}

async function main(): Promise<void> {
  const origin = await startPackagedUiServer(root, log)
  console.log(JSON.stringify({ v: 1, type: 'ready', uiOrigin: origin }))
}

async function shutdown(): Promise<void> {
  await stopPackagedUiServer()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})

main().catch((err) => {
  console.error(JSON.stringify({
    v: 1,
    type: 'fatal',
    message: err instanceof Error ? err.message : String(err),
  }))
  process.exit(1)
})
