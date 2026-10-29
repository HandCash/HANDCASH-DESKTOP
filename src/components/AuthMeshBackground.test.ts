import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('AuthMeshBackground', () => {
  const root = path.resolve(process.cwd(), 'src/components')

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
