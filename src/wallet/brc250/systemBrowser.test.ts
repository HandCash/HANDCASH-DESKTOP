import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInSystemBrowser } from './systemBrowser'

const URL = 'https://recovery.example/start?binding=abc'

afterEach(() => vi.unstubAllGlobals())

describe('openInSystemBrowser', () => {
  it('hands the URL to the system browser through the desktop bridge', async () => {
    const openExternal = vi.fn(async () => {})
    const open = vi.fn()
    vi.stubGlobal('window', { handcash: { openExternal }, open })
    await openInSystemBrowser(URL)
    expect(openExternal).toHaveBeenCalledWith(URL)
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to a new browser tab outside the desktop app', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    await openInSystemBrowser(URL)
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer')
  })
})
