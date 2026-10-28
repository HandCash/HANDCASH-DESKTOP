import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCloudPriorSession,
  detectUpgradeCloudSession,
  priorLoginContextFromSession,
  readCloudPriorSession,
  rememberCloudPriorSession,
} from './cloudPriorSession'

describe('cloud prior session', () => {
  afterEach(() => {
    clearCloudPriorSession()
  })

  it('starts with no prior login', () => {
    expect(readCloudPriorSession()).toBeNull()
    expect(priorLoginContextFromSession(null)).toEqual({ status: 'none' })
  })

  it('remembered session is signed-in for the entry chooser', () => {
    rememberCloudPriorSession({ handle: 'Alice', source: 'upgrade' })
    expect(readCloudPriorSession()).toMatchObject({
      handle: 'alice',
      source: 'upgrade',
    })
    expect(priorLoginContextFromSession()).toEqual({
      status: 'signed-in',
      handle: 'alice',
    })
  })

  it('signed-in without a handle still flips the entry to Migrate', () => {
    rememberCloudPriorSession({ source: 'migrate' })
    expect(priorLoginContextFromSession()).toEqual({ status: 'signed-in' })
  })

  it('detectUpgradeCloudSession reads the durable record (Mobile probe TODO)', () => {
    rememberCloudPriorSession({ handle: 'bob', source: 'upgrade' })
    expect(detectUpgradeCloudSession()?.handle).toBe('bob')
  })
})
