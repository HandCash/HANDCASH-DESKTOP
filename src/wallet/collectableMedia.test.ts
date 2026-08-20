import { describe, expect, it } from 'vitest'
import { collectableModelExtension, isCollectableModel } from './collectableMedia'

describe('collectableMedia', () => {
  it.each([
    'model/gltf-binary',
    'model/gltf+json',
    'model/gltf-binary; charset=binary',
    'application/gltf-buffer',
  ])('recognizes model MIME %s', (mimeType) => {
    expect(isCollectableModel({ mimeType, url: 'https://host/content/origin' })).toBe(true)
  })

  it('recognizes direct GLB and GLTF URLs', () => {
    expect(isCollectableModel({ url: 'https://host/model.glb?download=1' })).toBe(true)
    expect(isCollectableModel({ url: '/assets/model.gltf' })).toBe(true)
  })

  it('does not infer 3D from an app name or a JPEG body', () => {
    expect(
      isCollectableModel({
        mimeType: 'image/jpeg',
        url: 'https://ordinals.gorillapool.io/content/origin',
      }),
    ).toBe(false)
  })

  it('chooses a safe filename extension', () => {
    expect(collectableModelExtension('model/gltf+json', 'https://host/content/origin')).toBe('gltf')
    expect(collectableModelExtension('model/gltf-binary', 'https://host/content/origin')).toBe('glb')
  })
})
