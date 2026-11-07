import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scaleNodes, wrapPan } from './AuthMeshBackground'

describe('AuthMeshBackground', () => {
  it('wraps a panned node back into the padded mesh', () => {
    expect(wrapPan(500, 1000)).toBe(500)
    expect(wrapPan(-201, 1000)).toBe(1199)
    expect(wrapPan(1201, 1000)).toBe(-199)
  })

  it('carries nodes across a resize instead of clamping them onto the new edge', () => {
    const nodes = [{ x: 900, y: 400 }, { x: 100, y: 50 }]
    scaleNodes(nodes, 0.5, 0.25)
    expect(nodes).toEqual([{ x: 450, y: 100 }, { x: 50, y: 12.5 }])
    const mesh = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AuthMeshBackground.tsx'), 'utf8')
    expect(mesh).toContain('new ResizeObserver(resize)')
  })

  const root = path.resolve(process.cwd(), 'src/components')

  it('keeps phone tilt twenty times subtler than the original seven pixels per degree', () => {
    const mesh = fs.readFileSync(path.join(root, 'AuthMeshBackground.tsx'), 'utf8')
    const sensitivity = Number(mesh.match(/const TILT_PX_PER_DEG = ([\d.]+)/)?.[1])
    expect(sensitivity).toBe(7 / 20)
    expect(mesh).toContain('if (coarse) window.addEventListener(\'deviceorientation\', onTilt)')
  })

  it('is a single-plane decorative canvas mesh, not subtitle copy', () => {
    const mesh = fs.readFileSync(path.join(root, 'AuthMeshBackground.tsx'), 'utf8')
    expect(mesh).toContain('data-aeon-part="mesh"')
    expect(mesh).toContain('auth-mesh-canvas')
    expect(mesh).toContain('aria-hidden')
    expect(mesh).toContain('<canvas')
    expect(mesh).toContain('requestAnimationFrame')
    expect(mesh).toContain('NODE_COUNT')
    expect(mesh).toMatch(/NODE_COUNT\s*=\s*150/)
    // Light: black web + CTA green dots.
    expect(mesh).toMatch(/edgeR:\s*0/)
    expect(mesh).toMatch(/nodeR:\s*56,\s*\n?\s*nodeG:\s*203,\s*\n?\s*nodeB:\s*123/)
    expect(mesh).not.toMatch(/DEPTH_LAYER|parallax|buildMeshDepthPlanes|MESH_DEPTH/)
    expect(mesh).not.toMatch(/Sign in with a wallet|Bring your HandCash|Recover/)
  })

  it('fills the auth shell behind the centered foreground', () => {
    const shell = fs.readFileSync(path.join(root, 'AuthShell.tsx'), 'utf8')
    expect(shell).toContain('AuthMeshBackground')
    expect(shell).toContain('auth-shell-content')
    expect(shell).toContain('auth-shell-scrim')
    expect(shell).toMatch(/AuthMeshBackground[\s\S]{0,240}auth-shell-scrim/)
    expect(shell).not.toContain('AuthEntryField')
  })

  it('keeps full-bleed stage + soft scrim without a canvas opacity veil', () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), 'src/styles/handcash.css'),
      'utf8',
    )
    expect(css).toContain('.stage:has(.auth-shell)')
    expect(css).toContain('.auth-mesh-canvas')
    expect(css).toContain('.auth-shell-scrim')
    expect(css).not.toMatch(/\.auth-mesh-canvas\s*\{[^}]*opacity\s*:/)
  })
})
