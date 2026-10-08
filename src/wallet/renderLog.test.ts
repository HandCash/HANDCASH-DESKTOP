import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRender, resetRenderLogForTests } from './renderLog'

describe('recordRender', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    resetRenderLogForTests()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const lines = () => warn.mock.calls.map((c) => String(c[0]))

  it('logs a slow commit with its surface', () => {
    recordRender('activity', 'update', 2_422.4, 2_600, 0)
    recordRender('activity', 'update', 12, 2_600, 10)
    expect(lines()).toEqual(['[render] activity update 2422ms base 2600ms'])
  })

  it('reports a storm of cheap commits once the window closes', () => {
    for (let i = 0; i < 50; i += 1) recordRender('recent-activity', 'update', 8, 20, i * 100)
    expect(lines()).toEqual([])
    recordRender('recent-activity', 'update', 8, 20, 10_001)
    expect(lines()).toEqual(['[render] recent-activity storm 50 commits 400ms in 10s worst 8ms'])
  })

  it('stays quiet for an ordinary surface', () => {
    for (let i = 0; i < 10; i += 1) recordRender('nav', 'update', 5, 5, i * 1_000)
    recordRender('nav', 'update', 5, 5, 20_000)
    expect(lines()).toEqual([])
  })
})
