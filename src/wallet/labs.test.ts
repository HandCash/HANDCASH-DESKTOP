import { afterEach, describe, expect, it, vi } from 'vitest'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  LAB_FEATURES,
  isLabEnabled,
  setLabEnabled,
  subscribeLabs,
  trustsLocalHandCashHosts,
} from './labs'
import { storageRegistry } from '../storage/registry'

const KEY = storageRegistry.labs.key

afterEach(() => {
  for (const { id } of LAB_FEATURES) setLabEnabled(id, false)
  vi.unstubAllEnvs()
})

describe('labs', () => {
  it('starts with every feature off', () => {
    for (const { id } of LAB_FEATURES) expect(isLabEnabled(id)).toBe(false)
  })

  it('persists a feature turned on and forgets it when turned off', () => {
    setLabEnabled('localHandCashHosts', true)
    expect(isLabEnabled('localHandCashHosts')).toBe(true)
    expect(JSON.parse(durableGetItem(KEY) ?? '{}')).toEqual({ localHandCashHosts: true })
    setLabEnabled('localHandCashHosts', false)
    expect(isLabEnabled('localHandCashHosts')).toBe(false)
    expect(JSON.parse(durableGetItem(KEY) ?? '{}')).toEqual({})
  })

  it('reads anything but a literal true as off', () => {
    durableSetItem(KEY, JSON.stringify({ localHandCashHosts: 'yes' }))
    expect(isLabEnabled('localHandCashHosts')).toBe(false)
    expect(isLabEnabled('localHandCashHosts')).toBe(false)
    durableSetItem(KEY, 'not json')
    expect(isLabEnabled('localHandCashHosts')).toBe(false)
  })

  it('tells subscribers the new state', () => {
    const seen: unknown[] = []
    const stop = subscribeLabs((state) => seen.push(state))
    setLabEnabled('localHandCashHosts', true)
    stop()
    setLabEnabled('localHandCashHosts', false)
    expect(seen).toEqual([{ localHandCashHosts: true }])
  })

  it('trusts localhost in a shipped build only when the user opts in', () => {
    vi.stubEnv('DEV', false)
    expect(trustsLocalHandCashHosts()).toBe(false)
    setLabEnabled('localHandCashHosts', true)
    expect(trustsLocalHandCashHosts()).toBe(true)
  })
})
