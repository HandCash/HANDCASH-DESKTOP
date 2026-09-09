import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bridgeConnectUnavailableCode,
  bridgeConnectUnavailableMessage,
  bridgeCorsHeaders,
  decideWalletUiNavigation,
  DISABLE_HTTPS_FIRST_FEATURES,
} from './appConnectGuardrails.js'
import { isTrustedAppUrl } from './appUrlPolicy.js'
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
  it('never trusts https:// wallet-UI URLs as the live renderer origin', () => {
    // Allowing https://localhost:5173 navigation blanks Vite (HTTP-only) and
    // leaves every /getVersion as renderer-not-ready.
    expect(isTrustedAppUrl('https://localhost:5173/', policy)).toBe(false)
    expect(isTrustedAppUrl('https://127.0.0.1:5173/collectables/1', policy)).toBe(false)
    expect(isTrustedAppUrl('http://localhost:5173/', policy)).toBe(true)
  })

  it('blocks forced https:// wallet-UI URLs without loadURL', () => {
    expect(decideWalletUiNavigation('https://localhost:5173/', policy)).toEqual({
      action: 'block-https-upgrade',
      url: 'http://localhost:5173/',
    })
    expect(
      decideWalletUiNavigation('https://127.0.0.1:5173/collectables/1', policy, {
        eventKind: 'navigate',
      }),
    ).toEqual({
      action: 'block-https-upgrade',
      url: 'http://127.0.0.1:5173/collectables/1',
    })
    expect(
      decideWalletUiNavigation('https://localhost:5173/', policy, {
        eventKind: 'redirect',
      }),
    ).toEqual({
      action: 'block-https-upgrade',
      url: 'http://localhost:5173/',
    })
  })

  it('never returns a loadURL/reload decision for any wallet-UI URL', () => {
    const urls = [
      'https://localhost:5173/',
      'https://127.0.0.1:5173/',
      'http://localhost:5173/',
      'https://localhost:2121/getVersion',
      'https://www.lilb.it/market',
    ]
    for (const url of urls) {
      const decision = decideWalletUiNavigation(url, policy)
      expect(decision.action).not.toBe('reload-http')
      expect(decision).not.toHaveProperty('action', 'reload-http')
    }
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

    // Vite HMR / soft reload: did-start-loading clears readiness.
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

  it('ships the safe connect path in main/httpServer (no loadURL / webRequest rewrite)', async () => {
    const fs = await import('node:fs/promises')
    const mainSrc = await fs.readFile(new URL('./main.ts', import.meta.url), 'utf8')
    const httpSrc = await fs.readFile(new URL('./httpServer.ts', import.meta.url), 'utf8')

    // Soft mitigation only — do not reintroduce session rewrites or recovery loadURL.
    expect(mainSrc).toContain('DISABLE_HTTPS_FIRST_FEATURES')
    expect(mainSrc).toContain('decideWalletUiNavigation')
    expect(mainSrc).toContain("did-start-loading")
    expect(mainSrc).toContain('markRendererGone')
    expect(mainSrc).toContain("action === 'block-https-upgrade'")

    expect(mainSrc).not.toContain('webRequest.onBeforeRequest')
    expect(mainSrc).not.toContain('rewriteForcedHttpsUiUrl')
    expect(mainSrc).not.toContain('decideUiLoadRecovery')
    expect(mainSrc).not.toMatch(/reload-http[\s\S]{0,120}loadURL/)
    expect(mainSrc).not.toMatch(/recovering via[\s\S]{0,80}loadURL/)
    expect(mainSrc).not.toMatch(/blocked HTTPS upgrade[\s\S]{0,200}void mainWindow\.loadURL/)
    expect(mainSrc).not.toMatch(/block-https-upgrade[\s\S]{0,200}loadURL/)

    expect(httpSrc).toContain('bridgeConnectUnavailableMessage')
    expect(httpSrc).toContain('bridgeCorsHeaders')
  })
})
