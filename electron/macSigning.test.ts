import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const checkReleaseSigning: (context: unknown) => Promise<void> = require('../scripts/check-release-signing.cjs')

const SIGNING_ENV = [
  'HANDCASH_ALLOW_UNSIGNED',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
] as const
const savedEnv = Object.fromEntries(SIGNING_ENV.map((k) => [k, process.env[k]]))

function macContext() {
  const config = { forceCodeSigning: true, mac: { notarize: true } as { notarize: boolean; identity?: null } }
  return { electronPlatformName: 'darwin', packager: { config } }
}

describe('Mac signing config', () => {
  const mac = pkg.build.mac

  it('signs with the hardened runtime and notarizes', () => {
    expect(pkg.build.forceCodeSigning).toBe(true)
    expect(mac.hardenedRuntime).toBe(true)
    expect(mac.notarize).toBe(true)
    expect(mac.identity).toBeUndefined()
  })

  it('grants JIT and the camera, and keeps library validation on', () => {
    expect(mac.entitlementsInherit).toBe(mac.entitlements)
    const plist = fs.readFileSync(path.join(root, mac.entitlements), 'utf8')
    expect(plist).toContain('com.apple.security.cs.allow-jit')
    expect(plist).toContain('com.apple.security.device.camera')
    expect(plist).not.toContain('disable-library-validation')
    expect(mac.extendInfo.NSCameraUsageDescription).toMatch(/QR/)
  })
})

describe('check-release-signing', () => {
  afterEach(() => {
    for (const k of SIGNING_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  function clearEnv() {
    for (const k of SIGNING_ENV) delete process.env[k]
  }

  it('refuses a Mac release without notarization credentials', async () => {
    clearEnv()
    await expect(checkReleaseSigning(macContext())).rejects.toThrow(/notarization credentials/)
  })

  it('accepts an Apple ID with an app-specific password and team', async () => {
    clearEnv()
    process.env.APPLE_ID = 'dev@example.com'
    process.env.APPLE_APP_SPECIFIC_PASSWORD = 'placeholder'
    process.env.APPLE_TEAM_ID = 'ABCDE12345'
    await expect(checkReleaseSigning(macContext())).resolves.toBeUndefined()
  })

  it('turns signing and notarization off only through the explicit opt-out', async () => {
    clearEnv()
    process.env.HANDCASH_ALLOW_UNSIGNED = '1'
    const context = macContext()
    await checkReleaseSigning(context)
    expect(context.packager.config.forceCodeSigning).toBe(false)
    expect(context.packager.config.mac).toEqual({ notarize: false, identity: null })
  })
})
