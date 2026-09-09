import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bridgeConnectUnavailableCode,
  bridgeConnectUnavailableMessage,
  bridgeCorsHeaders,
  decideUiLoadRecovery,
  decideWalletUiNavigation,
  DISABLE_HTTPS_FIRST_FEATURES,
} from './appConnectGuardrails.js'
import { createBridgeWindowSource, type BridgeWindowLike } from './bridgeWindow.js'

const distRoot = path.resolve('/tmp/handcash/dist')
const policy = {
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] as const,
  packagedUiOrigin: 'http://localhost:5173',
  distRoot,
}

function fakeWindow(id = 1): BridgeWindowLike {
  return {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      send: () => {},
    },
  }
}

describe('app connect guardrails — HTTPS UI upgrade (connect killer)', () => {
  it('reloads HTTP on navigate instead of opening an external browser', () => {
    expect(decideWalletUiNavigation('https://localhost:5173/', policy)).toEqual({
      action: 'reload-http',
      url: 'http://localhost:5173/',
    })
    expect(
      decideWalletUiNavigation('https://127.0.0.1:5173/collectables/1', policy, {
        eventKind: 'navigate',
      }),
    ).toEqual({
      action: 'reload-http',
      url: 'http://127.0.0.1:5173/collectables/1',
    })
  })

  it('blocks HTTPS-First redirects without loadURL (keeps bridge renderer alive)', () => {
    // Regression: preventDefault + loadURL(http) on will-redirect fired
    // did-start-loading, cleared readiness, and every /getVersion answered
    // renderer-not-ready until restart.
    expect(
      decideWalletUiNavigation('https://localhost:5173/', policy, {
        eventKind: 'redirect',
      }),
    ).toEqual({
      action: 'block-https-upgrade',
      url: 'http://localhost:5173/',
    })
  })

  it('allows the real HTTP wallet origin and opens real apps externally', () => {
    expect(decideWalletUiNavigation('http://localhost:5173/', policy)).toEqual({
      action: 'allow',
    })
    expect(decideWalletUiNavigation('https://www.lilb.it/market', policy)).toEqual({
      action: 'open-external',
      url: 'https://www.lilb.it/market',
    })
  })

  it('never rewrites the BRC-100 HTTPS bridge (:2121) as the wallet UI', () => {
    expect(decideWalletUiNavigation('https://localhost:2121/getVersion', policy)).toEqual({
      action: 'open-external',
      url: 'https://localhost:2121/getVersion',
    })
    expect(decideWalletUiNavigation('https://127.0.0.1:2121/health', policy)).toEqual({
      action: 'open-external',
      url: 'https://127.0.0.1:2121/health',
    })
  })

  it('recovers did-fail-load ERR_SSL_PROTOCOL_ERROR on the UI origin', () => {
    expect(
      decideUiLoadRecovery({
        errorCode: -107,
        validatedURL: 'https://localhost:5173/',
        isMainFrame: true,
        policy,
        walletUiLoadUrl: 'http://localhost:5173/',
        attempts: 0,
      }),
    ).toBe('http://localhost:5173/')
  })

  it('does not loop forever on failed UI recovery', () => {
    expect(
      decideUiLoadRecovery({
        errorCode: -107,
        validatedURL: 'https://localhost:5173/',
        isMainFrame: true,
        policy,
        walletUiLoadUrl: 'http://localhost:5173/',
        attempts: 2,
      }),
    ).toBeNull()
  })

  it('ignores subframe / aborted failures', () => {
    expect(
      decideUiLoadRecovery({
        errorCode: -107,
        validatedURL: 'https://localhost:5173/',
        isMainFrame: false,
        policy,
        walletUiLoadUrl: 'http://localhost:5173/',
        attempts: 0,
      }),
    ).toBeNull()
    expect(
      decideUiLoadRecovery({
        errorCode: -3,
        validatedURL: 'https://localhost:5173/',
        isMainFrame: true,
        policy,
        walletUiLoadUrl: 'http://localhost:5173/',
        attempts: 0,
      }),
    ).toBeNull()
  })

  it('keeps HTTPS-First disabled in the shipped feature list', () => {
    expect(DISABLE_HTTPS_FIRST_FEATURES).toEqual(
      expect.arrayContaining([
        'HttpsFirstMode',
        'HttpsFirstModeV2',
        'HttpsUpgrades',
        'AutomaticHttpsUpgrades',
      ]),
    )
    expect(DISABLE_HTTPS_FIRST_FEATURES.join(',')).not.toMatch(/^\s*$/)
  })
})

describe('app connect guardrails — bridge readiness for /getVersion', () => {
  const immediateSleep = () => Promise.resolve()

  it('serves connect once the renderer re-registers after a reload', async () => {
    const window = fakeWindow(1)
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
      sleep: immediateSleep,
    })

    source.markRendererReady(1)
    expect((await source.acquire()).kind).toBe('ready')

    // Vite HMR / HTTPS-upgrade recovery: did-start-loading clears readiness.
    source.markRendererGone(1)
    expect(source.isRendererReady()).toBe(false)

    // Without re-register, apps see renderer-not-ready (the shipped failure).
    let clock = 0
    const waiting = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
      waitMs: 200,
      now: () => clock,
      sleep: async () => {
        clock += 100
      },
    })
    // Fresh source has no ready id — same as gone after reload before React remounts.
    expect(await waiting.acquire()).toEqual({
      kind: 'refuse',
      reason: 'renderer-not-ready',
    })

    source.markRendererReady(1)
    expect((await source.acquire()).kind).toBe('ready')
  })

  it('maps every bridge refusal to WALLET_BRIDGE_UNAVAILABLE with a stable reason tag', () => {
    for (const reason of [
      'renderer-not-ready',
      'window-unavailable',
      'app-quitting',
    ] as const) {
      const message = bridgeConnectUnavailableMessage(reason)
      expect(message.startsWith('WALLET_BRIDGE_UNAVAILABLE:')).toBe(true)
      expect(message.endsWith(`(${reason})`)).toBe(true)
      expect(bridgeConnectUnavailableCode(message)).toBe('WALLET_BRIDGE_UNAVAILABLE')
    }
  })

  it('maps renderer-not-ready to the exact client-facing description', () => {
    expect(bridgeConnectUnavailableMessage('renderer-not-ready')).toBe(
      'WALLET_BRIDGE_UNAVAILABLE: wallet window is still loading (renderer-not-ready)',
    )
    expect(bridgeConnectUnavailableCode('HTTP_BRIDGE_ERROR: boom')).toBeNull()
  })

  it('exposes Private Network Access CORS so HTTPS sites can hit localhost', () => {
    const headers = bridgeCorsHeaders()
    expect(headers['Access-Control-Allow-Private-Network']).toBe('true')
    expect(headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('wires shipped main/httpServer modules to these guardrails', async () => {
    const fs = await import('node:fs/promises')
    const mainSrc = await fs.readFile(
      new URL('./main.ts', import.meta.url),
      'utf8',
    )
    const httpSrc = await fs.readFile(
      new URL('./httpServer.ts', import.meta.url),
      'utf8',
    )
    expect(mainSrc).toContain('DISABLE_HTTPS_FIRST_FEATURES')
    expect(mainSrc).toContain('decideWalletUiNavigation')
    expect(mainSrc).toContain('decideUiLoadRecovery')
    expect(httpSrc).toContain('bridgeConnectUnavailableMessage')
    expect(httpSrc).toContain('bridgeCorsHeaders')
  })
})
