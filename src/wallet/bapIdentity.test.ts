import { describe, expect, it } from 'vitest'
import { BAP_BASKET, BAP_BITCOM_ADDRESS, BAP_KEY_ID, BAP_PROTOCOL_ID } from './bapIdentity'

describe('bapIdentity constants', () => {
  it('matches 1sat / Yours BAP path', () => {
    expect(BAP_PROTOCOL_ID).toEqual([1, 'sigma'])
    expect(BAP_KEY_ID).toBe('identity')
    expect(BAP_BASKET).toBe('bap')
    expect(BAP_BITCOM_ADDRESS).toBe('1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT')
  })
})
