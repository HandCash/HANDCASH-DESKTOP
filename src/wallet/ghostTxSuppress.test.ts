import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetGhostTxSuppressForTests,
  isGhostTxSuppressed,
  rememberGhostTx,
} from './ghostTxSuppress'
import { noteTxLanded, resetLandedTxForTests, txLanded } from './landedTx'

const TX = 'e0'.repeat(32)

describe('ghostTxSuppress', () => {
  afterEach(() => {
    __resetGhostTxSuppressForTests()
    resetLandedTxForTests()
  })

  it('suppresses a tx with a hard verdict', () => {
    rememberGhostTx(TX)
    expect(isGhostTxSuppressed(TX)).toBe(true)
  })

  it('lets a landing reported after the mark outrank it', () => {
    rememberGhostTx(TX)
    noteTxLanded(TX)
    expect(isGhostTxSuppressed(TX)).toBe(false)
  })

  it('never suppresses a landed tx a stale mark still names', () => {
    noteTxLanded(TX)
    expect(isGhostTxSuppressed(TX)).toBe(false)
  })

  it('lets a later proof of death outrank the landing', () => {
    noteTxLanded(TX)
    rememberGhostTx(TX)
    expect(txLanded(TX)).toBe(false)
    expect(isGhostTxSuppressed(TX)).toBe(true)
  })
})
