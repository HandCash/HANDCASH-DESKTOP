/**
 * Keep the hermetic suite offline by default.
 *
 * Individual tests that need HTTP must stub `fetch` themselves after this runs.
 * Production paths that catch provider failures are allowed to attempt and fail
 * closed — they must not escape onto the real network.
 */
import { beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(
        `Unexpected network request in hermetic suite: ${String(input)}`,
      )
    }),
  )
})
