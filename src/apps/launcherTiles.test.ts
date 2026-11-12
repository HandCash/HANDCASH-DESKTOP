import { describe, expect, it } from 'vitest'
import { builtinApps } from './builtin'
import { desktopChartSupport } from './desktopEffectPorts'
import { launcherTiles } from './launcherTiles'
import type { ConnectedApp } from '../wallet/permissions'

const peer = { origin: 'https://game.example', name: 'Game', connectedAt: 1 } as ConnectedApp

describe('launcher tiles', () => {
  it('lists Notes, then the chart apps that verify, then peer apps', () => {
    const charts = builtinApps(desktopChartSupport('main'))
    const tiles = launcherTiles(charts, [peer])
    expect(tiles[0]).toMatchObject({ id: 'native:notes', kind: 'native', label: 'Notes' })
    const chartIds = tiles.filter((t) => t.kind === 'chart').map((t) => t.id)
    expect(chartIds).toEqual(charts.filter((c) => c.verification.ok).map((c) => `chart:${c.id}`))
    expect(tiles.at(-1)).toMatchObject({ kind: 'peer', origin: 'https://game.example', label: 'Game' })
  })

  it('keeps a chart app that fails verification out of the launcher', () => {
    const [first] = builtinApps(desktopChartSupport('main'))
    const refused = { ...first!, verification: { ok: false as const, reason: 'hash' as const, errors: ['changed'] } }
    expect(launcherTiles([refused], []).map((t) => t.kind)).toEqual(['native'])
  })
})
