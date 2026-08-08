import { describe, expect, it } from 'vitest'
import { extFromMime, filenameForCollectable } from './imageHandoff'

describe('imageHandoff', () => {
  it('maps common image MIME types to extensions', () => {
    expect(extFromMime('image/png')).toBe('png')
    expect(extFromMime('image/jpeg; charset=binary')).toBe('jpg')
    expect(extFromMime('image/webp')).toBe('webp')
    expect(extFromMime('image/svg+xml')).toBe('svg')
    expect(extFromMime(undefined)).toBe('png')
    expect(extFromMime('application/octet-stream')).toBe('png')
  })

  it('builds a safe download filename from the item name', () => {
    expect(filenameForCollectable('Cool Ordinal #42', 'png')).toBe('Cool-Ordinal-42.png')
    expect(filenameForCollectable('  ***  ', 'jpeg')).toBe('collectable.jpeg')
    expect(filenameForCollectable('../secret', 'png')).toBe('secret.png')
    expect(filenameForCollectable('a'.repeat(80), 'png').length).toBe(64)
  })
})
