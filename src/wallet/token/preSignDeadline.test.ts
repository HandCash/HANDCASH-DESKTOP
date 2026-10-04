import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPreSignDeadline, TokenPreSignTimeoutError } from './preSignDeadline'

describe('startPreSignDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('names the step a stuck send was waiting in and frees the caller', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preSign = startPreSignDeadline('bsv21', 1_000)
    await expect(preSign.step('clearing reservations', Promise.resolve())).resolves.toBeUndefined()

    const stuck = preSign.step('loading the tip transactions', new Promise<never>(() => {}))
    const settled = expect(stuck).rejects.toMatchObject({
      name: 'TokenPreSignTimeoutError',
      step: 'loading the tip transactions',
      message: 'Token send stalled while loading the tip transactions — nothing was signed. Try again.',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[bsv21\] pre-sign timed out in loading the tip transactions after \d+ms$/),
    )
  })

  it('shares one budget across steps rather than granting each its own', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preSign = startPreSignDeadline('bsv21', 1_000)
    const slow = preSign.step(
      'resolving the recipient',
      new Promise<string>((resolve) => setTimeout(() => resolve('addr'), 800)),
    )
    await vi.advanceTimersByTimeAsync(800)
    await expect(slow).resolves.toBe('addr')

    const next = preSign.step('checking token ancestry', () => new Promise<never>(() => {}))
    const settled = expect(next).rejects.toBeInstanceOf(TokenPreSignTimeoutError)
    await vi.advanceTimersByTimeAsync(200)
    await settled
  })

  it('logs a slow step so triage can attribute the wait', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const preSign = startPreSignDeadline('bsv21')
    const step = preSign.step(
      'loading token parents',
      new Promise<number>((resolve) => setTimeout(() => resolve(7), 300)),
    )
    await vi.advanceTimersByTimeAsync(300)
    await expect(step).resolves.toBe(7)
    expect(info).toHaveBeenCalledWith('[bsv21] pre-sign loading token parents done 300ms')
  })
})
