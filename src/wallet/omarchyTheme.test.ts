import { describe, expect, it } from 'vitest'
import { contrastRatio } from './colorFormat'
import { omarchyPalette, type OmarchyColors } from './omarchyTheme'

const tokyoNight: OmarchyColors = {
  mode: 'dark',
  name: 'tokyo-night',
  background: '#1a1b26',
  darkBackground: '#13141c',
  darkerBackground: '#0e0e14',
  lighterBackground: '#24283b',
  foreground: '#a9b1d6',
  darkForeground: '#565f89',
  lightForeground: '#a9b1d6',
  brightForeground: '#c0caf5',
  accent: '#7aa2f7',
  muted: '#414868',
  selection: '#292e42',
  red: '#f7768e',
  green: '#9ece6a',
}

const omarchyWhite: OmarchyColors = {
  mode: 'light',
  name: 'white',
  background: '#ffffff',
  darkBackground: '#f5f5f5',
  darkerBackground: '#e8e8e8',
  lighterBackground: '#c0c0c0',
  foreground: '#000000',
  darkForeground: '#c0c0c0',
  lightForeground: '#000000',
  brightForeground: '#000000',
  accent: '#6e6e6e',
  muted: '#808080',
  selection: '#c0c0c0',
  red: '#2a2a2a',
  green: '#3a3a3a',
}

const catppuccinLatte: OmarchyColors = {
  mode: 'light',
  name: 'catppuccin-latte',
  background: '#eff1f5',
  darkBackground: '#e3e4e8',
  darkerBackground: '#d7d8dc',
  lighterBackground: '#dce0e8',
  foreground: '#4c4f69',
  darkForeground: '#9ca0b0',
  lightForeground: '#5c5f77',
  brightForeground: '#4c4f69',
  accent: '#1e66f5',
  muted: '#acb0be',
  selection: '#ccd0da',
  red: '#d20f39',
  green: '#40a02b',
}

describe('omarchyPalette', () => {
  it('maps tokyo-night onto brand tokens', () => {
    const p = omarchyPalette(tokyoNight)
    expect(p.bg).toBe('#0e0e14')
    expect(p.surface).toBe('#1a1b26')
    expect(p.surfaceRaised).toBe('#24283b')
    expect(p.accent).toBe('#7aa2f7')
    expect(p.text).toBe('#c0caf5')
    expect(p.border).toBe('#292e42')
    expect(p.danger).toBe('#f7768e')
  })

  it('uses light backgrounds for light themes', () => {
    const p = omarchyPalette({ ...tokyoNight, mode: 'light', background: '#eff1f5' })
    expect(p.bg).toBe('#eff1f5')
  })

  it('keeps muted labels readable on Omarchy White (rejects ghost grey)', () => {
    const p = omarchyPalette(omarchyWhite)
    expect(contrastRatio(p.muted, p.bg)).toBeGreaterThanOrEqual(4.5)
    expect(p.muted).not.toBe('#c0c0c0')
    expect(p.surface).toBe('#f5f5f5')
  })

  it('lifts latte cards to white and prefers mid ink for muted', () => {
    const p = omarchyPalette(catppuccinLatte)
    expect(p.surface).toBe('#ffffff')
    expect(p.muted).toBe('#5c5f77')
    expect(contrastRatio(p.muted, p.bg)).toBeGreaterThanOrEqual(4.5)
  })
})
