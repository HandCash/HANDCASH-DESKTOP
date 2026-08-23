import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearWalletProgress,
  finishWalletProgress,
  getWalletProgress,
  isWalletProgressBusy,
  resetWalletProgressForTests,
  showsActivityWalletProgress,
  startWalletProgress,
  updateWalletProgress,
  walletProgressDetail,
  walletProgressLabel,
  walletProgressPercent,
} from './walletProgress'

afterEach(() => {
  resetWalletProgressForTests()
  vi.useRealTimers()
})

describe('walletProgress', () => {
  it('starts a refresh job as running busy', () => {
    startWalletProgress({
      kind: 'refresh',
      phase: 'scanning',
      message: 'Refreshing funds against the network',
    })
    const snap = getWalletProgress()
    expect(snap.status).toBe('running')
    expect(snap.kind).toBe('refresh')
    expect(isWalletProgressBusy(snap)).toBe(true)
    expect(walletProgressLabel(snap)).toBe('Syncing')
    expect(walletProgressDetail(snap)).toMatch(/Refreshing funds/i)
    expect(showsActivityWalletProgress(snap)).toBe(false)
  })

  it('tracks chunk current/total for 1sat import progress', () => {
    startWalletProgress({
      kind: 'one-sat-import',
      phase: 'importing-items',
      current: 0,
      total: 96,
      message: 'Importing collectables',
    })
    updateWalletProgress({ current: 48, failed: 1 })
    const snap = getWalletProgress()
    expect(snap.current).toBe(48)
    expect(snap.total).toBe(96)
    expect(snap.failed).toBe(1)
    expect(walletProgressPercent(snap)).toBe(50)
    expect(walletProgressLabel(snap)).toBe('Importing')
    expect(walletProgressDetail(snap)).toMatch(/Importing collectables/i)
    expect(showsActivityWalletProgress(snap)).toBe(false)
  })

  it('keeps catching-up busy after soft-deadline style phase change', () => {
    startWalletProgress({ kind: 'refresh', phase: 'scanning' })
    updateWalletProgress({
      phase: 'catching-up',
      message: 'Still importing collectables…',
    })
    const snap = getWalletProgress()
    expect(isWalletProgressBusy(snap)).toBe(true)
    expect(walletProgressLabel(snap)).toBe('Catching up')
    expect(walletProgressDetail(snap)).toMatch(/Still importing/i)
    expect(showsActivityWalletProgress(snap)).toBe(false)
  })

  it('never shows Activity wallet progress — sweep panel only', () => {
    startWalletProgress({ kind: 'refresh', phase: 'scanning' })
    expect(showsActivityWalletProgress()).toBe(false)
    updateWalletProgress({ kind: 'one-sat-import', phase: 'importing-items' })
    expect(showsActivityWalletProgress()).toBe(false)
    startWalletProgress({
      kind: 'phrase-import',
      phase: 'migrating',
      current: 1,
      total: 10,
    })
    expect(showsActivityWalletProgress()).toBe(false)
  })

  it('records phrase-import moved/offset style counters', () => {
    startWalletProgress({
      kind: 'phrase-import',
      phase: 'migrating',
      current: 0,
      total: 200,
    })
    updateWalletProgress({
      current: 40,
      skipped: 3,
      failed: 1,
      message: '40 imported · 43 scanned',
    })
    const snap = getWalletProgress()
    expect(walletProgressLabel(snap)).toBe('Sweeping')
    expect(snap.skipped).toBe(3)
    expect(walletProgressPercent(snap)).toBe(20)
  })

  it('finishes to done then auto-clears', () => {
    vi.useFakeTimers()
    startWalletProgress({ kind: 'one-sat-import', current: 10, total: 10 })
    finishWalletProgress('done', { message: 'Import complete' })
    expect(getWalletProgress().status).toBe('done')
    expect(isWalletProgressBusy()).toBe(false)
    vi.advanceTimersByTime(2_500)
    expect(getWalletProgress().status).toBe('idle')
  })

  it('ignores updates while idle', () => {
    clearWalletProgress()
    updateWalletProgress({ current: 5 })
    expect(getWalletProgress().current).toBeNull()
  })

  it('keeps needs-resume without auto-clear', () => {
    vi.useFakeTimers()
    startWalletProgress({ kind: 'phrase-import', current: 12 })
    finishWalletProgress('needs-resume', {
      message: 'Paused — add BSV to continue',
    })
    expect(getWalletProgress().status).toBe('needs-resume')
    vi.advanceTimersByTime(5_000)
    expect(getWalletProgress().status).toBe('needs-resume')
    expect(walletProgressLabel()).toBe('Sweep paused')
  })
})
