import { describe, expect, it } from 'vitest'
import {
  classifyUnlockFailure,
  isWalletMismatchMessage,
  rawUnlockError,
} from './unlockFailure'

/**
 * The report that motivated this: a Windows holder upgraded, saw "Welcome back",
 * entered the right password, and got a red "Internal error." — Chromium's text for
 * a partition it could not open, with no cause named and no way forward.
 */
describe('classifyUnlockFailure', () => {
  it('translates Chromium’s bare store error and opens recovery', () => {
    const err = new DOMException('Internal error.', 'UnknownError')
    const failure = classifyUnlockFailure(err)

    expect(failure.kind).toBe('storeUnreadable')
    expect(failure.offerRestore).toBe(true)
    expect(failure.message).not.toMatch(/internal error/i)
    expect(failure.message).toMatch(/other copy of HandCash/i)
    expect(failure.message).toMatch(/recovery phrase/i)
  })

  it('classifies a locked store by name even when the message says nothing', () => {
    for (const name of ['UnknownError', 'InvalidStateError', 'VersionError']) {
      expect(classifyUnlockFailure(new DOMException('', name)).kind).toBe('storeUnreadable')
    }
  })

  it('recognises a backing-store failure that lost its DOMException name', () => {
    const err = new Error('Internal error opening backing store for indexedDB.open')
    expect(classifyUnlockFailure(err).kind).toBe('storeUnreadable')
  })

  it('names a full disk instead of blaming the wallet', () => {
    const failure = classifyUnlockFailure(new DOMException('', 'QuotaExceededError'))

    expect(failure.kind).toBe('diskFull')
    expect(failure.message).toMatch(/out of space/i)
    // Restoring cannot help until there is room to write.
    expect(failure.offerRestore).toBe(false)
  })

  it('keeps mismatch copy exactly as thrown, since it already addresses the holder', () => {
    const thrown = 'This phrase does not match the funded wallet on this device'
    const failure = classifyUnlockFailure(new Error(thrown))

    expect(failure.kind).toBe('walletMismatch')
    expect(failure.message).toBe(thrown)
    expect(failure.offerRestore).toBe(true)
  })

  it('passes an ordinary failure through untouched', () => {
    const failure = classifyUnlockFailure(new Error('Wrong password'))

    expect(failure.kind).toBe('other')
    expect(failure.message).toBe('Wrong password')
    expect(failure.offerRestore).toBe(false)
  })

  it('survives a non-Error rejection', () => {
    expect(classifyUnlockFailure('boom').kind).toBe('other')
    expect(classifyUnlockFailure(undefined).message).toBe('undefined')
  })
})

describe('rawUnlockError', () => {
  it('keeps the name so support can tell the two store causes apart', () => {
    expect(rawUnlockError(new DOMException('Internal error.', 'UnknownError'))).toBe(
      'UnknownError: Internal error.',
    )
  })

  it('does not repeat a name the message already carries', () => {
    const err = new Error('Error: already prefixed')
    expect(rawUnlockError(err)).toBe('Error: already prefixed')
  })
})

describe('isWalletMismatchMessage', () => {
  it('ignores empty input', () => {
    expect(isWalletMismatchMessage(null)).toBe(false)
    expect(isWalletMismatchMessage('')).toBe(false)
  })
})
