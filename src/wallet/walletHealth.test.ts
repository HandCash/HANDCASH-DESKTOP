import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindSyncHealthAccount,
  getSyncHealth,
  setSyncHealth,
} from './walletHealth'

describe('walletHealth account stamp', () => {
  afterEach(() => {
    bindSyncHealthAccount(null)
  })

  it('starts a never-seen vault account idle', () => {
    bindSyncHealthAccount({ identityKey: 'ik-root', accountIndex: 0 })
    setSyncHealth({ phase: 'ok', message: null })
    expect(getSyncHealth().phase).toBe('ok')
    expect(getSyncHealth().identityKey).toBe('ik-root')

    bindSyncHealthAccount({ identityKey: 'ik-child', accountIndex: 1 })
    expect(getSyncHealth().phase).toBe('idle')
    expect(getSyncHealth().identityKey).toBe('ik-child')
    expect(getSyncHealth().message).toBeNull()
  })

  it('restores each vault account sync state when switching back', () => {
    bindSyncHealthAccount({ identityKey: 'ik-a', accountIndex: 10 })
    setSyncHealth({ phase: 'syncing', message: 'syncing A', heldOneSats: 2 })
    bindSyncHealthAccount({ identityKey: 'ik-b', accountIndex: 11 })
    setSyncHealth({ phase: 'ok', message: null, heldOneSats: 7 })

    bindSyncHealthAccount({ identityKey: 'ik-a', accountIndex: 10 })
    expect(getSyncHealth()).toMatchObject({
      phase: 'syncing',
      message: 'syncing A',
      heldOneSats: 2,
      identityKey: 'ik-a',
    })
    bindSyncHealthAccount({ identityKey: 'ik-b', accountIndex: 11 })
    expect(getSyncHealth()).toMatchObject({
      phase: 'ok',
      heldOneSats: 7,
      identityKey: 'ik-b',
    })
  })

  it('drops sync patches stamped for a prior account', () => {
    bindSyncHealthAccount({ identityKey: 'ik-child', accountIndex: 1 })
    setSyncHealth({ phase: 'syncing', message: 'child sync' })
    setSyncHealth({
      phase: 'ok',
      message: 'root leftover',
      identityKey: 'ik-root',
      accountIndex: 0,
    })
    expect(getSyncHealth().phase).toBe('syncing')
    expect(getSyncHealth().message).toBe('child sync')
    expect(getSyncHealth().identityKey).toBe('ik-child')
  })
})

describe('walletHealth reason', () => {
  afterEach(() => {
    vi.useRealTimers()
    bindSyncHealthAccount(null)
  })

  it('a phase change without a reason clears the last one', () => {
    bindSyncHealthAccount({ identityKey: 'ik-r', accountIndex: 0 })
    setSyncHealth({ phase: 'ok', reason: 'timeout', message: 'slow' })
    expect(getSyncHealth().reason).toBe('timeout')
    setSyncHealth({ heldOneSats: 3 })
    expect(getSyncHealth().reason).toBe('timeout')
    setSyncHealth({ phase: 'ok', message: null })
    expect(getSyncHealth().reason).toBeNull()
  })

  it('a hung refresh with ingest idle ends as a timeout, not a clean sync', async () => {
    vi.useFakeTimers()
    bindSyncHealthAccount({ identityKey: 'ik-w', accountIndex: 0 })
    setSyncHealth({ phase: 'syncing', message: 'refreshing' })
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.dynamicImportSettled()
    await vi.waitFor(() => expect(getSyncHealth().phase).toBe('ok'))
    expect(getSyncHealth().reason).toBe('timeout')
    expect(getSyncHealth().message).toMatch(/local balance/)
  })
})
