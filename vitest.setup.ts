/**
 * Keep the hermetic suite offline by default.
 *
 * Individual tests that need HTTP must stub `fetch` themselves after this runs.
 * Production paths that catch provider failures are allowed to attempt and fail
 * closed — they must not escape onto the real network.
 */
import { beforeEach, vi } from 'vitest'
import {
  bindAccountLocalKeyScope,
  resetAccountLocalKeyScopeForTests,
} from './src/wallet/accountLocalKeys'

// Node 25+ defines a global localStorage that is unusable without --localstorage-file;
// CI runs Node 22, where it does not exist.
if ('localStorage' in globalThis && typeof window === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true })
}

beforeEach(() => {
  resetAccountLocalKeyScopeForTests()
  bindAccountLocalKeyScope({
    accountIndex: 0,
    identityKey: 'vitest-primary-identity',
    chain: 'main',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(
        `Unexpected network request in hermetic suite: ${String(input)}`,
      )
    }),
  )
})
