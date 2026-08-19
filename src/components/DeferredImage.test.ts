import { describe, expect, it } from 'vitest'
import { decodedImageCacheSize, rememberDecodedUrl } from './DeferredImage'

describe('DeferredImage decoded URL cache', () => {
  it('stays bounded during long collectables browsing sessions', () => {
    for (let i = 0; i < 750; i += 1) {
      rememberDecodedUrl(`https://images.example/${i}.png`)
    }
    expect(decodedImageCacheSize()).toBeLessThanOrEqual(500)
  })
})
