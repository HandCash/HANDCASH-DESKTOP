import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { guardStdioWrites, isBrokenPipe } from './brokenPipe.js'

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`write ${code}`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('isBrokenPipe', () => {
  it('recognizes a reader that has gone away', () => {
    expect(isBrokenPipe(errno('EPIPE'))).toBe(true)
    expect(isBrokenPipe(errno('ERR_STREAM_DESTROYED'))).toBe(true)
  })

  it('does not claim unrelated failures', () => {
    expect(isBrokenPipe(errno('ENOSPC'))).toBe(false)
    expect(isBrokenPipe(new Error('write failed'))).toBe(false)
    expect(isBrokenPipe(null)).toBe(false)
    expect(isBrokenPipe(undefined)).toBe(false)
  })
})

describe('guardStdioWrites', () => {
  it('keeps a closed pipe from reaching the uncaught-exception path', () => {
    const stdout = new EventEmitter()
    const onWriteError = vi.fn()
    guardStdioWrites([stdout], onWriteError)

    // Without a listener this emit throws, which is exactly how a lost stdout
    // became a crash dialog.
    expect(() => stdout.emit('error', errno('EPIPE'))).not.toThrow()
    expect(onWriteError).not.toHaveBeenCalled()
  })

  it('still reports a real logging fault', () => {
    const stderr = new EventEmitter()
    const onWriteError = vi.fn()
    guardStdioWrites([stderr], onWriteError)

    const disk = errno('ENOSPC')
    expect(() => stderr.emit('error', disk)).not.toThrow()
    expect(onWriteError).toHaveBeenCalledWith(disk)
  })

  it('guards every stream it is given', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    guardStdioWrites([stdout, stderr])

    expect(() => stdout.emit('error', errno('EPIPE'))).not.toThrow()
    expect(() => stderr.emit('error', errno('EPIPE'))).not.toThrow()
  })

  it('does not crash when the reporter itself throws', () => {
    const stdout = new EventEmitter()
    guardStdioWrites([stdout], () => {
      throw new Error('logger is broken too')
    })

    expect(() => stdout.emit('error', errno('ENOSPC'))).not.toThrow()
  })
})
