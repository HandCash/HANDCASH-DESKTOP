import { describe, expect, it } from 'vitest'
import { SCREEN_PICK_MS, createScreenPick, isScreenSourceId, toScreenSourceViews } from './screenShare.js'

const image = (url: string) => ({ isEmpty: () => url === '', toDataURL: () => url })

describe('screen share sources', () => {
  it('lists screens before windows and leaves out HandCash’s own windows', () => {
    const views = toScreenSourceViews(
      [
        { id: 'window:12:0', name: 'Notes', thumbnail: image('data:image/png;base64,AA') },
        { id: 'window:7:0', name: 'HandCash', thumbnail: image('data:image/png;base64,BB') },
        { id: 'screen:1:0', name: '', thumbnail: image('') },
      ],
      ['window:7:0'],
    )
    expect(views).toEqual([
      { id: 'screen:1:0', name: 'Screen', kind: 'screen', thumbnail: '' },
      { id: 'window:12:0', name: 'Notes', kind: 'window', thumbnail: 'data:image/png;base64,AA' },
    ])
  })

  it('accepts only desktop source ids', () => {
    expect(isScreenSourceId('screen:0:0')).toBe(true)
    expect(isScreenSourceId('window:1234:0')).toBe(true)
    expect(isScreenSourceId('file:///etc/passwd')).toBe(false)
    expect(isScreenSourceId(42)).toBe(false)
  })

  it('a pick is good once, and only while fresh', () => {
    let t = 0
    const pick = createScreenPick(() => t)
    expect(pick.take()).toBeNull()
    pick.choose('screen:0:0')
    expect(pick.take()).toBe('screen:0:0')
    expect(pick.take()).toBeNull()
    pick.choose('window:3:0')
    t = SCREEN_PICK_MS + 1
    expect(pick.take()).toBeNull()
  })
})
