import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Linux without a keyring: Electron falls back to `basic_text`, a key built
 * into Chromium. New vault writes are not sealed with it, a vault sealed with
 * it earlier still opens, and a vault sealed by a keyring that is now missing
 * says so instead of looking like a computer with no wallet.
 */

let userData = ''
let backend = 'gnome_libsecret'
let available = true

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => Buffer.from(`${backend}:${value}`),
    decryptString: (buf: Buffer) => {
      const text = buf.toString()
      if (!text.startsWith(`${backend}:`)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text.slice(backend.length + 1)
    },
  },
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const VAULT_KEY = 'handcash.brc100.vault.v1'
const platform = process.platform

async function loadStore() {
  vi.resetModules()
  return import('./durableStore.js')
}

function storeFile(): string {
  return path.join(userData, 'durable-prefs.json')
}

function writeSealedVault(sealedWith: string, plain: string): void {
  const sealed = `sealed:v1:${Buffer.from(`${sealedWith}:${plain}`).toString('base64')}`
  fs.writeFileSync(storeFile(), JSON.stringify({ [VAULT_KEY]: sealed }), 'utf8')
}

function onDisk(key: string): string | undefined {
  return (JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>)[key]
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-keyring-'))
  Object.defineProperty(process, 'platform', { value: 'linux' })
  backend = 'gnome_libsecret'
  available = true
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('durable store on Linux', () => {
  it('seals the vault with a keyring', async () => {
    const { durableGet, durableSet, durableSafeStorageAvailable } = await loadStore()
    expect(durableSafeStorageAvailable()).toBe(true)
    expect(durableSet(VAULT_KEY, '{"identityKey":"a"}')).toBe(true)
    expect(onDisk(VAULT_KEY)?.startsWith('sealed:v1:')).toBe(true)
    expect(durableGet(VAULT_KEY)).toBe('{"identityKey":"a"}')
    expect(onDisk('handcash.brc100.vaultSealStatus')).toBe('sealed')
  })

  it('does not seal with basic_text, and records the vault as unsealed', async () => {
    backend = 'basic_text'
    const { durableSet, durableSafeStorageAvailable } = await loadStore()
    expect(durableSafeStorageAvailable()).toBe(false)
    expect(durableSet(VAULT_KEY, '{"identityKey":"a"}')).toBe(true)
    expect(onDisk(VAULT_KEY)).toBe('{"identityKey":"a"}')
    expect(onDisk('handcash.brc100.vaultSealStatus')).toBe('unsealed')
  })

  it('still opens a vault an older version sealed with basic_text', async () => {
    backend = 'basic_text'
    writeSealedVault('basic_text', '{"identityKey":"a"}')
    const { durableGet, durableVaultOpenError } = await loadStore()
    expect(durableVaultOpenError()).toBeNull()
    expect(durableGet(VAULT_KEY)).toBe('{"identityKey":"a"}')
  })

  it('names the missing keyring when a keyring-sealed vault cannot open', async () => {
    writeSealedVault('gnome_libsecret', '{"identityKey":"a"}')
    backend = 'basic_text'
    const { durableGet, durableVaultOpenError } = await loadStore()
    expect(durableGet(VAULT_KEY)).toBeNull()
    expect(durableVaultOpenError()).toMatch(/GNOME Keyring or KWallet/)
  })

  it('names the missing keyring when no key store answers at all', async () => {
    writeSealedVault('gnome_libsecret', '{"identityKey":"a"}')
    available = false
    const { durableVaultOpenError } = await loadStore()
    expect(durableVaultOpenError()).toMatch(/system keyring/)
  })

  it('reports nothing when there is no vault or it opens', async () => {
    const { durableSet, durableVaultOpenError } = await loadStore()
    expect(durableVaultOpenError()).toBeNull()
    durableSet(VAULT_KEY, '{"identityKey":"a"}')
    expect(durableVaultOpenError()).toBeNull()
  })
})
