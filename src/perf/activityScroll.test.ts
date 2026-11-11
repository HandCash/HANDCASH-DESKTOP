import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('list scrolling stays off the render path', () => {
  it('activity rows skip re-render when the window shifts, and still repaint on cache moves', () => {
    const source = read('../components/RecentActivity.tsx')
    expect(source).toMatch(/const FeedHistoryRow = memo\(HistoryRow\)/)
    expect(source).not.toMatch(/<HistoryRow\b/)
    expect(source).toMatch(/<FeedHistoryRow[\s\S]{0,200}paint=\{paint\}/)
    expect(source).toMatch(/const \[paint, setRepaint\] = useState\(0\)/)
  })

  it('lists that ignore the scrolling flag report scrolls without subscribing to it', () => {
    for (const path of [
      '../components/RecentActivity.tsx',
      '../components/InventoryPanel.tsx',
      '../components/import/ImportItemBrowser.tsx',
    ]) {
      const source = read(path)
      expect(source, path).toMatch(/useReportFeedScroll\(listRef\)/)
      expect(source, path).not.toMatch(/useScrollIdle\(/)
    }
  })
})
