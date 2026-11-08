import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDirectory } from './atomicFile.js'

const realPlatform = process.platform
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p })
}
function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

afterEach(() => {
  setPlatform(realPlatform)
  vi.restoreAllMocks()
})

describe('syncDirectory', () => {
  it('fsyncs a real directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))
    expect(() => syncDirectory(dir)).not.toThrow()
  })

  it.each(['EPERM', 'EISDIR', 'EACCES'])('ignores %s on win32', (code) => {
    setPlatform('win32')
    vi.spyOn(fs, 'openSync').mockReturnValue(7 as never)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw errno(code) })
    const close = vi.spyOn(fs, 'closeSync').mockImplementation(() => {})
    expect(() => syncDirectory('C:\\x')).not.toThrow()
    expect(close).toHaveBeenCalledWith(7)
  })

  it('ignores EPERM from opening the directory on win32', () => {
    setPlatform('win32')
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EPERM') })
    expect(() => syncDirectory('C:\\x')).not.toThrow()
  })

  it('rethrows other errors on win32 and EPERM elsewhere', () => {
    setPlatform('win32')
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EIO') })
    expect(() => syncDirectory('C:\\x')).toThrow('EIO')
    setPlatform('linux')
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EPERM') })
    expect(() => syncDirectory('/x')).toThrow('EPERM')
  })
})
