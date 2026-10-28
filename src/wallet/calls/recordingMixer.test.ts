import { describe, expect, it } from 'vitest'
import { tileLayout } from './recordingMixer'

describe('recording tile layout', () => {
  it('fills the frame with equal tiles that never overlap, centring a short last row', () => {
    expect(tileLayout(0, 1280, 720)).toEqual([])
    expect(tileLayout(1, 1280, 720, 0)).toEqual([{ x: 0, y: 0, w: 1280, h: 720 }])
    for (let n = 1; n <= 6; n += 1) {
      const tiles = tileLayout(n, 1280, 720)
      expect(tiles).toHaveLength(n)
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0)
        expect(t.y).toBeGreaterThanOrEqual(0)
        expect(t.x + t.w).toBeLessThanOrEqual(1280)
        expect(t.y + t.h).toBeLessThanOrEqual(720)
      }
      for (const a of tiles) {
        for (const b of tiles) {
          if (a === b) continue
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
          expect(apart).toBe(true)
        }
      }
    }
    const three = tileLayout(3, 1280, 720, 0)
    expect(three[2]!.x).toBe(320)
  })
})
