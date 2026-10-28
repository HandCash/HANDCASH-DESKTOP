import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armCloudMigrationIntent,
  consumeCloudMigrationIntent,
  peekCloudMigrationIntent,
  resetCloudMigrationIntentForTests,
} from './cloudMigrationIntent'

vi.mock('./import', () => ({
  requestImportKind: vi.fn(),
}))
vi.mock('./navStore', () => ({
  openSetting: vi.fn(),
}))

describe('cloud migration intent', () => {
  afterEach(() => {
    resetCloudMigrationIntentForTests()
    vi.clearAllMocks()
  })

  it('arms until consumed once', async () => {
    const { requestImportKind } = await import('./import')
    const { openSetting } = await import('./navStore')
    expect(peekCloudMigrationIntent()).toBe(false)
    armCloudMigrationIntent()
    expect(peekCloudMigrationIntent()).toBe(true)
    expect(consumeCloudMigrationIntent()).toBe(true)
    expect(requestImportKind).toHaveBeenCalledWith('handcash')
    expect(openSetting).toHaveBeenCalledWith('import')
    expect(peekCloudMigrationIntent()).toBe(false)
    expect(consumeCloudMigrationIntent()).toBe(false)
  })
})
