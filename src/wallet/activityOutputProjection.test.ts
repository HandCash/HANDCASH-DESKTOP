import { afterEach, expect, it, vi } from 'vitest'
import { activityOutputProjection } from './activityOutputProjection'

afterEach(() => vi.unstubAllGlobals())

const page = { database: 'wallet', userId: 1, basketId: 3, limit: 10 }

it('refuses renderer reads when background workers are unavailable', async () => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('Worker', undefined)
  const projection = activityOutputProjection()
  await expect(projection.read(page)).rejects.toThrow('background projection unavailable')
  projection.close()
})

it('terminates a failed worker and does not fall back to renderer reads', async () => {
  vi.stubGlobal('window', {})
  const terminate = vi.fn()
  vi.stubGlobal('Worker', class {
    onerror: (() => void) | null = null
    terminate = terminate
    postMessage() { queueMicrotask(() => this.onerror?.()) }
  })
  const projection = activityOutputProjection()
  await expect(projection.read(page)).rejects.toThrow('background projection unavailable')
  await expect(projection.read(page)).rejects.toThrow('background projection unavailable')
  expect(terminate).toHaveBeenCalledOnce()
  projection.close()
})
