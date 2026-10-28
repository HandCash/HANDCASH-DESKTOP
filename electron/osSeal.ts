/**
 * OS vault seal used by the Node durable-prefs helper.
 * Native Mac/Win/Linux hosts seal in Swift/Rust; this module keeps the old
 * sealed:v1: format for tests and any leftover Node tooling. Default: unavailable.
 */
export type OsSealBackend = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(buf: Buffer): string
}

const unavailable: OsSealBackend = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'basic_text',
  encryptString: () => {
    throw new Error('OS seal unavailable')
  },
  decryptString: () => {
    throw new Error('OS seal unavailable')
  },
}

let backend: OsSealBackend = unavailable

export function getOsSeal(): OsSealBackend {
  return backend
}

/** Test-only: install a fake keyring (replaces Electron safeStorage mocks). */
export function setOsSealForTests(next: OsSealBackend | null): void {
  backend = next ?? unavailable
}
