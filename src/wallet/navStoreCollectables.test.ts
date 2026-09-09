import { afterEach, describe, expect, it } from 'vitest'
import {
  closeEmbeddedAppBrowser,
  getNavState,
  openEmbeddedAppBrowser,
  openBurnCollectables,
  openSendCollectables,
  setNavSection,
} from './navStore'

afterEach(() => {
  closeEmbeddedAppBrowser()
  setNavSection('activity')
})

describe('collectable batch navigation', () => {
  it('keeps a stable deduplicated batch payload', () => {
    openSendCollectables(['a.0', 'b.0', 'a.0'])
    expect(getNavState()).toEqual({
      section: 'collectables',
      child: { type: 'send-collectables', outpoints: ['a.0', 'b.0'] },
    })
  })

  it('uses the compatible single-item child for one outpoint', () => {
    openBurnCollectables(['a.0'])
    expect(getNavState()).toEqual({
      section: 'collectables',
      child: { type: 'burn-collectable', outpoint: 'a.0' },
    })
  })

  it('opens an embedded app browser in the Apps section', () => {
    openEmbeddedAppBrowser('https://handcash.io', 'https://handcash.io/apps')
    expect(getNavState()).toEqual({
      section: 'apps',
      child: {
        type: 'app-browser',
        origin: 'https://handcash.io',
        url: 'https://handcash.io/apps',
      },
    })
  })
})
