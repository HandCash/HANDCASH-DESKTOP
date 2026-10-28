import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEPTH_LAYER_COUNT,
  MESH_DEPTH_PLANES,
  buildMeshDepthPlanes,
} from './AuthEntryField'
import {
  BRIDGE_ALPHA_SCALE,
  EDGE_LINK_DIST,
  FIELD_MARGIN,
  FIELD_TRAVEL_X,
  FIELD_TRAVEL_Y,
  MAX_PULSES,
  NODE_DAMPING,
  NODE_DRIFT,
  NODE_MAX_SPEED,
  PULSE_SPAWN_INTERVAL,
  TOTAL_MESH_NODES,
  framePresence,
  stepNodes,
  type MeshNode,
} from './entryMeshMotion'

describe('AuthEntryField', () => {
  const root = path.resolve(process.cwd(), 'src/components')

  it('is a full-bleed decorative canvas mesh, not subtitle copy', () => {
    const field = fs.readFileSync(path.join(root, 'auth/AuthEntryField.tsx'), 'utf8')
    expect(field).toContain('data-aeon-part="entry-field"')
    expect(field).toContain('data-aeon-scope="entry-mesh"')
    expect(field).toContain('aria-hidden')
    expect(field).toContain('<canvas')
    expect(field).toContain('requestAnimationFrame')
    expect(field).toContain('entryMeshMachine')
    expect(field).toContain('prefersReducedMotion')
    expect(field).not.toMatch(/Sign in with a wallet|Bring your HandCash|Recover/)
    expect(field).not.toContain('flowAt')
  })

  it('builds many receding planes on Items Market elastic base', () => {
    expect(DEPTH_LAYER_COUNT).toBeGreaterThanOrEqual(18)
    expect(DEPTH_LAYER_COUNT).toBeLessThanOrEqual(36)
    expect(MESH_DEPTH_PLANES).toHaveLength(DEPTH_LAYER_COUNT)
    // Longer reach = more thin lines (not fatter strokes).
    expect(EDGE_LINK_DIST).toBeGreaterThanOrEqual(140)
    expect(EDGE_LINK_DIST).toBeLessThanOrEqual(180)
    expect(TOTAL_MESH_NODES).toBeGreaterThanOrEqual(280)
    expect(TOTAL_MESH_NODES).toBeLessThanOrEqual(420)

    let nodeSum = 0
    for (let i = 1; i < MESH_DEPTH_PLANES.length; i++) {
      const prev = MESH_DEPTH_PLANES[i - 1]!
      const next = MESH_DEPTH_PLANES[i]!
      expect(prev.parallax).toBeLessThan(next.parallax)
      expect(prev.speedMul).toBeLessThan(next.speedMul)
      expect(prev.alphaMul).toBeLessThan(next.alphaMul)
      expect(prev.radiusMin).toBeLessThan(next.radiusMin)
      expect(prev.maxDist).toBeLessThanOrEqual(next.maxDist)
      expect(prev.count).toBeGreaterThanOrEqual(6)
      nodeSum += prev.count
    }
    nodeSum += MESH_DEPTH_PLANES[MESH_DEPTH_PLANES.length - 1]!.count
    expect(nodeSum).toBe(TOTAL_MESH_NODES)

    const far = MESH_DEPTH_PLANES[0]!
    const near = MESH_DEPTH_PLANES[MESH_DEPTH_PLANES.length - 1]!
    // Distance stays populated; near still densest. Far whispers into backdrop.
    expect(near.count).toBeGreaterThanOrEqual(far.count)
    expect(near.count).toBeGreaterThanOrEqual(20)
    expect(far.count).toBeGreaterThanOrEqual(8)
    expect(far.alphaMul).toBeLessThanOrEqual(0.1)
    expect(near.alphaMul).toBe(1)
    expect(near.alphaMul - far.alphaMul).toBeGreaterThan(0.85)
    expect(near.parallax - far.parallax).toBeGreaterThan(0.8)
    expect(near.speedMul).toBe(1)
    expect(far.speedMul).toBeLessThanOrEqual(0.4)
    expect(near.speedMul / far.speedMul).toBeGreaterThan(2.2)
    // Near plane matches Items Market motion knobs.
    expect(NODE_DAMPING).toBeCloseTo(0.9982, 4)
    expect(NODE_DRIFT).toBeCloseTo(0.055, 4)
    expect(NODE_MAX_SPEED).toBeCloseTo(1.35, 4)
    expect(near.drift).toBeCloseTo(NODE_DRIFT, 4)
    expect(far.drift).toBeCloseTo(NODE_DRIFT, 4)
    expect(near.maxSpeed).toBeCloseTo(NODE_MAX_SPEED, 4)

    const field = fs.readFileSync(path.join(root, 'auth/AuthEntryField.tsx'), 'utf8')
    expect(field).toMatch(/CAM_AMP|entryMeshMotion/)
    const motion = fs.readFileSync(path.join(root, 'auth/entryMeshMotion.ts'), 'utf8')
    expect(motion).toContain('CAM_AMP')
    expect(motion).toContain('FIELD_TRAVEL_X')
    expect(motion).toContain('EDGE_LINK_DIST')
    expect(motion).toContain('ADJACENT_DEPTH_GAP')
    expect(motion).toContain('byDepth')
    expect(motion).toContain('BRIDGE_ALPHA_SCALE')
    expect(motion).toContain('dissolveRgb')
    expect(motion).toContain('easeInOutSine')
    expect(motion).not.toContain('easeOutBack')
    expect(FIELD_TRAVEL_X).toBeGreaterThan(0.3)
    expect(FIELD_TRAVEL_Y).toBeGreaterThan(0.05)
    expect(FIELD_TRAVEL_X).toBeGreaterThan(FIELD_TRAVEL_Y)
    expect(FIELD_MARGIN).toBeGreaterThanOrEqual(100)
    expect(MAX_PULSES).toBeGreaterThanOrEqual(28)
    expect(PULSE_SPAWN_INTERVAL).toBeLessThanOrEqual(6)
    expect(BRIDGE_ALPHA_SCALE).toBeGreaterThanOrEqual(0.45)
    expect(BRIDGE_ALPHA_SCALE).toBeLessThan(0.75)
    expect(near.edgeMul).toBe(1)
    expect(far.edgeMul).toBeLessThanOrEqual(0.2)
    // Thin strokes — density from reach, not weight.
    expect(motion).toMatch(/lineWidth = 0\.9/)
    expect(motion).not.toContain('flowAt')
  })

  it('buildMeshDepthPlanes stays monotonic for other layer counts in band', () => {
    for (const n of [10, 24, 30]) {
      const planes = buildMeshDepthPlanes(n)
      expect(planes).toHaveLength(n)
      for (let i = 1; i < planes.length; i++) {
        expect(planes[i - 1]!.parallax).toBeLessThan(planes[i]!.parallax)
      }
    }
  })

  it('wraps past the frame margin so peers fade out before re-entering', () => {
    expect(NODE_DAMPING).toBeGreaterThan(0.99)
    expect(NODE_DAMPING).toBeLessThan(1)

    const node: MeshNode = {
      x: -FIELD_MARGIN - 2,
      y: 100,
      vx: -0.4,
      vy: 0,
      radius: 1,
      depth: MESH_DEPTH_PLANES.length - 1,
    }
    stepNodes([node], 400, 300)
    expect(node.x).toBeGreaterThan(400)
    expect(node.vx).toBeLessThan(0)
  })

  it('keeps full presence inside the frame and fades across the margin', () => {
    expect(framePresence(200, 150, 400, 300)).toBe(1)
    expect(framePresence(-FIELD_MARGIN / 2, 150, 400, 300)).toBeCloseTo(0.5, 1)
    expect(framePresence(-FIELD_MARGIN, 150, 400, 300)).toBe(0)
  })

  it('traverses infinite field — near shifts farther than far each step', () => {
    const far: MeshNode = {
      x: 200,
      y: 150,
      vx: 0,
      vy: 0,
      radius: 1,
      depth: 0,
    }
    const near: MeshNode = {
      x: 200,
      y: 150,
      vx: 0,
      vy: 0,
      radius: 1,
      depth: MESH_DEPTH_PLANES.length - 1,
    }
    stepNodes([far, near], 400, 300)
    expect(Math.abs(near.x - 200)).toBeGreaterThan(Math.abs(far.x - 200))
  })

  it('fills the entry screen behind the centered foreground', () => {
    const auth = fs.readFileSync(path.join(root, 'AuthScreen.tsx'), 'utf8')
    expect(auth).toContain('AuthEntryField')
    expect(auth).toContain('auth-entry-foreground')
    expect(auth).toMatch(/AuthEntryField[\s\S]{0,200}auth-entry-foreground/)
    // Brand mark above the HandCash title — entry must read as HandCash first.
    expect(auth).toContain('BrandLogo')
    expect(auth).toMatch(/auth-entry-brand[\s\S]{0,120}auth-title/)
  })

  it('keeps full-bleed stage + soft scrim without a canvas opacity veil', () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), 'src/styles/handcash.css'),
      'utf8',
    )
    expect(css).toContain('.stage:has(.auth-screen-entry)')
    expect(css).toContain('.auth-entry-field')
    expect(css).toContain('.auth-entry-scrim')
    expect(css).not.toMatch(/\.auth-entry-field\s*\{[^}]*opacity\s*:/)
    expect(css).toMatch(/color-mix\(in srgb, var\(--hc-bg\) 28%, transparent\)/)
    // Drag over mesh/entry must not flash the text I-beam.
    expect(css).toMatch(/\.stage:has\(\.auth-screen-entry\),\s*\.stage:has\(\.auth-screen-entry\) \*\s*\{[^}]*user-select:\s*none/)
    expect(css).toMatch(/\.auth-screen\[data-aeon-state='entry'\]\.auth-screen-entry\s*\{[^}]*cursor:\s*default/)
    expect(fs.readFileSync(path.join(root, 'auth/AuthEntryField.tsx'), 'utf8')).toContain(
      "selectstart",
    )
  })
})
