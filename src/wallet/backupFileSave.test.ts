import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveBackupFile } from './backupFileSave'

function withSave(save: unknown) {
  vi.stubGlobal('window', { handcash: { saveBackupFile: save } })
}

afterEach(() => vi.unstubAllGlobals())

describe('saveBackupFile', () => {
  it('sends the text as bytes and reports where it was saved', async () => {
    const save = vi.fn(async () => ({ ok: true as const, saved: true as const, path: '/b/slice.txt', bytes: 5 }))
    withSave(save)

    await expect(saveBackupFile('slice.txt', 'share')).resolves.toEqual({ saved: true, path: '/b/slice.txt' })
    expect(save).toHaveBeenCalledWith({ filename: 'slice.txt', bytes: new TextEncoder().encode('share') })
  })

  it('reports nothing saved when the dialog is cancelled', async () => {
    withSave(async () => ({ ok: true, saved: false }))

    await expect(saveBackupFile('slice.txt', 'share')).resolves.toEqual({ saved: false })
  })

  it('throws the reason when the save fails', async () => {
    withSave(async () => ({ ok: false, error: 'The disk is full. Nothing was saved.' }))

    await expect(saveBackupFile('slice.txt', 'share')).rejects.toThrow('The disk is full. Nothing was saved.')
  })
})

describe('backup screens save files only through the verified save', () => {
  const sources = {
    create: 'components/CreateKeysBackupPanel.tsx',
    settings: 'components/WalletBackupPanel.tsx',
    history: 'wallet/historyBackup.ts',
  }
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

  it('never hands a backup to an unverified browser download', () => {
    for (const file of Object.values(sources)) {
      const source = read(file)
      expect(source, file).toContain('saveBackupFile(')
      expect(source, file).not.toMatch(/createObjectURL|\.download\s*=/)
    }
  })

  it('marks a slice or the history export done only after the file is saved', () => {
    for (const file of [sources.create, sources.settings]) {
      expect(read(file), file).toMatch(/if \(!saved\.saved\) return\s+noteKeysBackupHandoff\(index\)/)
    }
    expect(read('components/HistoryBackupPanel.tsx')).toMatch(/if \(saved\.saved\) \{[^}]*markExported\(\)/)
  })
})
