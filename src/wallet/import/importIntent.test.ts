import { describe, expect, it } from 'vitest'
import { brc100Contract } from '../../contracts/brc100'
import { getNavState } from '../navStore'
import { isMigrationOrigin, openKeyRecoveryPayload } from '../migration'
import { requestImportKind, subscribeImportIntent, takeImportIntent } from './importIntent'
import { clearRecoveryHintsForTests, recoveryHintsFor } from './recoveryHints'

describe('import intent', () => {
  it('holds one request until the panel takes it', () => {
    const seen: Array<string | null> = []
    const off = subscribeImportIntent((kind) => seen.push(kind))
    requestImportKind('handcash')
    expect(takeImportIntent()).toBe('handcash')
    expect(takeImportIntent()).toBeNull()
    off()
    expect(seen).toEqual([null, 'handcash'])
  })

  it('hands a late subscriber the waiting request', () => {
    requestImportKind('handcash')
    let first: string | null = null
    const off = subscribeImportIntent((kind) => {
      first ??= kind
    })
    off()
    expect(first).toBe('handcash')
    takeImportIntent()
  })
})

describe('openKeyRecovery', () => {
  it('is a migrate method, so only HandCash hosts may call it', () => {
    expect(brc100Contract.isMigrationMethod('openKeyRecovery')).toBe(true)
    expect(isMigrationOrigin('https://market.handcash.io')).toBe(true)
    expect(isMigrationOrigin('https://example.com')).toBe(false)
  })

  it('opens Settings → Import on the HandCash form and moves nothing', () => {
    expect(openKeyRecoveryPayload()).toEqual({ opened: true, kind: 'handcash', hints: 'none' })
    expect(getNavState()).toMatchObject({
      section: 'settings',
      child: { type: 'setting', settingId: 'import' },
    })
    expect(takeImportIntent()).toBe('handcash')
  })

  it('holds HandCash history hints for the next HandCash scan', () => {
    clearRecoveryHintsForTests()
    const txid = 'ab'.repeat(32)
    expect(
      openKeyRecoveryPayload({ hints: { handle: 'alice', txids: [txid], historyComplete: true, satoshis: 500 } }),
    ).toEqual({ opened: true, kind: 'handcash', hints: 'accepted' })
    expect(recoveryHintsFor({ kind: 'handcash', handle: null })).toMatchObject({ txids: [txid], satoshis: 500 })
    expect(openKeyRecoveryPayload({ hints: { txids: ['junk'] } }).hints).toBe('none')
    takeImportIntent()
  })
})
