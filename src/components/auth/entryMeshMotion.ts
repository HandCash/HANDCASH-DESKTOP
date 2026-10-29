/**
 * Entry mesh — Items Market HeroBackground reverse-decomposed: same floaty
 * elastic peers (damping / drift / wrap travel-by), near + one far plane owned by
 * `entryMeshMachine`. Near = Market density + thin long-reach webs; far =
 * 3× further / 4× larger, dissolves into backdrop. Same-depth + adjacent
 * bridges only — not an all-pair spiderweb.
 */
import { ENTRY_MESH_LAYER_COUNT } from '../../machines/entryMeshMachine'

/** Layer count — owned by the entryMesh chart. */
export const DEPTH_LAYER_COUNT = ENTRY_MESH_LAYER_COUNT
/** Link reach — longer than Market 120 so webs read denser (more lines, not fatter). */
export const EDGE_LINK_DIST = 158
/**
 * Near carries Market density; extra nodes feed farther planes.
 * Same-depth + adjacent bridges only — not an all-pair spiderweb.
 */
export const TOTAL_MESH_NODES = 380
/** Max depth gap for faint bridge edges (same-depth = 0). */
export const ADJACENT_DEPTH_GAP = 1
/** Cross-depth bridges — clear but quieter than same-depth webs. */
export const BRIDGE_ALPHA_SCALE = 0.55
export const BRIDGE_DIST_SCALE = 0.85

/** Depth index: 0 = farthest, DEPTH_LAYER_COUNT - 1 = nearest. */
export type MeshDepth = number

export type MeshPlane = {
  count: number
  speedMul: number
  maxSpeed: number
  drift: number
  radiusMin: number
  radiusSpan: number
  alphaMul: number
  edgeMul: number
  maxDist: number
  /** Camera parallax weight (near moves more than far). */
  parallax: number
  /** Perspective shrink from screen center (far < 1). */
  scale: number
}

export type MeshNode = {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  depth: MeshDepth
}

export type MeshPulse = {
  fromIdx: number
  toIdx: number
  progress: number
  speed: number
  ease: (t: number) => number
  depth: MeshDepth
}

/** Items Market — long drift, mesh stays alive. */
export const NODE_DAMPING = 0.9982
/** Items Market base drift; planes scale from this. */
export const NODE_DRIFT = 0.055
/** Items Market base max speed; near plane matches. */
export const NODE_MAX_SPEED = 1.35

/** Visualized tx dots — snappy travel across the grid. */
const PULSE_SPEED_MIN = 0.018
const PULSE_SPEED_MAX = 0.048
export const MAX_PULSES = 36
export const PULSE_SPAWN_INTERVAL = 3
const SPLIT_CHANCE = 0.38
const SPLIT_COUNT_MIN = 2
const SPLIT_COUNT_MAX = 5

/** Past-frame margin — wrap later so lines/nodes fade out of view, not at the rim. */
export const FIELD_MARGIN = 140

/** Continuous traverse through an infinite field (px/frame at full parallax). */
export const FIELD_TRAVEL_X = 0.62
export const FIELD_TRAVEL_Y = 0.2
/** Soft meander on top of travel — slower, smaller than a hard orbit. */
export const CAM_AMP_X = 22
export const CAM_AMP_Y = 14
export const CAM_RATE_X = 0.00007
export const CAM_RATE_Y = 0.000052
const CAM_SOFT_X = 0.28
const CAM_SOFT_Y = 0.28

/** Soft-close only — no snap end, no overshoot. */
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
const easings = [easeOutQuart, easeOutCubic, easeInOutCubic, easeInOutSine]

/** Near plane = Items Market knobs (parallax/scale 1). Far is derived from these. */
const NEAR_RADIUS_MIN = 0.7
const NEAR_RADIUS_SPAN = 1.2
/** Extra plane sits this many times farther than near (parallax + perspective). */
export const FAR_DISTANCE_MUL = 3
/** Extra plane nodes are this many times larger than near (screen radius). */
export const FAR_SIZE_MUL = 4

/**
 * Build N planes. Product default is 2: near Market + one far plane at
 * FAR_DISTANCE_MUL× further and FAR_SIZE_MUL× larger. Exported for tests.
 */
export function buildMeshDepthPlanes(n: number): MeshPlane[] {
  const layers = Math.max(2, Math.floor(n))

  if (layers === 2) {
    const farCount = Math.max(12, Math.round(TOTAL_MESH_NODES * 0.55))
    const nearCount = Math.max(10, TOTAL_MESH_NODES - farCount)
    const near: MeshPlane = {
      count: nearCount,
      speedMul: 1,
      maxSpeed: NODE_MAX_SPEED,
      drift: NODE_DRIFT,
      radiusMin: NEAR_RADIUS_MIN,
      radiusSpan: NEAR_RADIUS_SPAN,
      alphaMul: 1,
      edgeMul: 1,
      maxDist: EDGE_LINK_DIST * 0.95,
      parallax: 1,
      scale: 1,
    }
    const far: MeshPlane = {
      count: farCount,
      speedMul: near.speedMul / FAR_DISTANCE_MUL,
      maxSpeed: near.maxSpeed / FAR_DISTANCE_MUL,
      drift: NODE_DRIFT,
      radiusMin: near.radiusMin * FAR_SIZE_MUL,
      radiusSpan: near.radiusSpan * FAR_SIZE_MUL,
      // Far stays lit enough to read; near is full.
      alphaMul: 0.55,
      edgeMul: 0.6,
      // Longer reach so the recessed web still densifies.
      maxDist: EDGE_LINK_DIST * 1.15,
      parallax: near.parallax / FAR_DISTANCE_MUL,
      scale: near.scale / FAR_DISTANCE_MUL,
    }
    return [far, near]
  }

  const weights: number[] = []
  let weightSum = 0
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1)
    // Far gets the crowd so distant grids read; near stays densest but not alone.
    const w = 1.15 - t * 0.35
    weights.push(w)
    weightSum += w
  }

  const planes: MeshPlane[] = []
  let assigned = 0
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1)
    const count =
      i === layers - 1
        ? Math.max(10, TOTAL_MESH_NODES - assigned)
        : Math.max(12, Math.round((weights[i]! / weightSum) * TOTAL_MESH_NODES))
    assigned += count
    planes.push({
      count,
      // Market drift; far slower but still travels past.
      speedMul: 0.32 + t * 0.68,
      maxSpeed: NODE_MAX_SPEED * (0.32 + t * 0.68),
      drift: NODE_DRIFT,
      // Far still visible dots; near = Market radius band.
      radiusMin: 0.35 + t * 0.35,
      radiusSpan: 0.45 + t * 0.75,
      // Far grids stay lit; near full. Paint softens RGB with depth.
      alphaMul: 0.48 + t * 0.52,
      edgeMul: 0.55 + t * 0.45,
      // Far needs longer reach so its web densifies on the scaled plane.
      maxDist: EDGE_LINK_DIST * (1.15 - 0.2 * t),
      // Wide parallax — far barely tracks camera, near full.
      parallax: 0.04 + t * 0.96,
      // Recede far planes toward center so depth layers separate.
      scale: 0.52 + t * 0.48,
    })
  }
  return planes
}

/** Depth plane knobs — exported for tests. Index 0 = far. */
export const MESH_DEPTH_PLANES: MeshPlane[] = buildMeshDepthPlanes(DEPTH_LAYER_COUNT)

export const DEPTH_ORDER: MeshDepth[] = MESH_DEPTH_PLANES.map((_, i) => i)

function depthT(depth: MeshDepth): number {
  const last = MESH_DEPTH_PLANES.length - 1
  return last <= 0 ? 1 : depth / last
}

export function isLightSheet(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.aeonMode === 'light'
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function cameraOffset(timeMs: number, animate: boolean): { camX: number; camY: number } {
  if (!animate) return { camX: 0, camY: 0 }
  const camX =
    Math.sin(timeMs * CAM_RATE_X) * CAM_AMP_X +
    Math.sin(timeMs * CAM_RATE_X * 0.37 + 1.1) * (CAM_AMP_X * CAM_SOFT_X)
  const camY =
    Math.cos(timeMs * CAM_RATE_Y) * CAM_AMP_Y +
    Math.cos(timeMs * CAM_RATE_Y * 0.41 + 0.7) * (CAM_AMP_Y * CAM_SOFT_Y)
  return { camX, camY }
}

/** Soft Market drift + continuous traverse + wrap — infinite field fly-through. */
export function stepNodes(nodes: MeshNode[], w: number, h: number): void {
  for (const n of nodes) {
    const plane = MESH_DEPTH_PLANES[n.depth]!
    n.vx *= NODE_DAMPING
    n.vy *= NODE_DAMPING
    n.vx += (Math.random() - 0.5) * plane.drift
    n.vy += (Math.random() - 0.5) * plane.drift

    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
    if (speed > plane.maxSpeed) {
      n.vx = (n.vx / speed) * plane.maxSpeed
      n.vy = (n.vy / speed) * plane.maxSpeed
    }

    // Near rushes past; far crawls — feel of traversing endless depth.
    n.x += n.vx * plane.speedMul - FIELD_TRAVEL_X * plane.parallax
    n.y += n.vy * plane.speedMul - FIELD_TRAVEL_Y * plane.parallax

    // Wrap past the frame so peers fade out of view before re-entering.
    const spanX = w + 2 * FIELD_MARGIN
    const spanY = h + 2 * FIELD_MARGIN
    if (n.x < -FIELD_MARGIN) n.x += spanX
    else if (n.x > w + FIELD_MARGIN) n.x -= spanX
    if (n.y < -FIELD_MARGIN) n.y += spanY
    else if (n.y > h + FIELD_MARGIN) n.y -= spanY
  }
}

/** 1 inside the frame; soft falloff across FIELD_MARGIN outside (fade later). */
export function framePresence(x: number, y: number, w: number, h: number): number {
  let px = 1
  if (x < 0) px = 1 + x / FIELD_MARGIN
  else if (x > w) px = 1 - (x - w) / FIELD_MARGIN
  let py = 1
  if (y < 0) py = 1 + y / FIELD_MARGIN
  else if (y > h) py = 1 - (y - h) / FIELD_MARGIN
  return Math.max(0, Math.min(1, px, py))
}

export function seedNodes(w: number, h: number): MeshNode[] {
  const nodes: MeshNode[] = []
  for (const depth of DEPTH_ORDER) {
    const plane = MESH_DEPTH_PLANES[depth]!
    for (let i = 0; i < plane.count; i++) {
      nodes.push({
        x: Math.random() * Math.max(w, 1),
        y: Math.random() * Math.max(h, 1),
        // Items Market initial kick — same energy on every plane.
        vx: (Math.random() - 0.5) * 1.4,
        vy: (Math.random() - 0.5) * 1.4,
        radius: plane.radiusMin + Math.random() * plane.radiusSpan,
        depth,
      })
    }
  }
  return nodes
}

function indicesFor(nodes: MeshNode[], depth: MeshDepth): number[] {
  const out: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.depth === depth) out.push(i)
  }
  return out
}

function pickPulseDepth(): MeshDepth {
  const last = MESH_DEPTH_PLANES.length - 1
  const r = Math.random()
  // Bias pulses toward nearer (Market-visible) planes.
  return Math.min(last, Math.floor(r ** 0.55 * MESH_DEPTH_PLANES.length))
}

export function spawnPulses(nodes: MeshNode[], pulses: MeshPulse[]): void {
  if (pulses.length >= MAX_PULSES || nodes.length < 2) return
  const depth = pickPulseDepth()
  const fromPool = indicesFor(nodes, depth)
  const fromIdx =
    fromPool.length > 0
      ? fromPool[Math.floor(Math.random() * fromPool.length)]!
      : Math.floor(Math.random() * nodes.length)
  const from = nodes[fromIdx]!
  const isSplit = Math.random() < SPLIT_CHANCE
  const numTargets = isSplit
    ? SPLIT_COUNT_MIN + Math.floor(Math.random() * (SPLIT_COUNT_MAX - SPLIT_COUNT_MIN + 1))
    : 1
  const used = new Set<number>([fromIdx])
  for (let t = 0; t < numTargets && pulses.length < MAX_PULSES; t++) {
    let toIdx = Math.floor(Math.random() * nodes.length)
    for (let tries = 0; used.has(toIdx) && tries < 20; tries++) {
      toIdx = Math.floor(Math.random() * nodes.length)
    }
    used.add(toIdx)
    const to = nodes[toIdx]!
    const gap = Math.abs(to.depth - from.depth)
    if (gap > ADJACENT_DEPTH_GAP) continue
    const dist = Math.hypot(from.x - to.x, from.y - to.y)
    const maxD =
      gap === 0
        ? MESH_DEPTH_PLANES[from.depth]!.maxDist * 1.6
        : MESH_DEPTH_PLANES[from.depth]!.maxDist * BRIDGE_DIST_SCALE * 1.4
    if (dist >= maxD) continue
    pulses.push({
      fromIdx,
      toIdx,
      progress: 0,
      speed: PULSE_SPEED_MIN + Math.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN),
      ease: easings[Math.floor(Math.random() * easings.length)]!,
      depth: from.depth,
    })
  }
}

export function paintFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: MeshNode[],
  pulses: MeshPulse[],
  animate: boolean,
  timeMs: number,
): void {
  ctx.clearRect(0, 0, w, h)

  const dark = !isLightSheet()
  // Readable thin lines (density from reach, not stroke weight).
  const edgeAlphaBase = dark ? 0.7 : 0.42
  const nodeAlphaBase = dark ? 0.82 : 0.4

  /** Far softens into backdrop but keeps a strong floor so distant grids read. */
  const dissolveRgb = (t: number) => {
    const near = Math.max(0, Math.min(1, t))
    if (dark) {
      // Floor ~0.55 — farthest layer stays neon, not charcoal.
      const k = 0.55 + 0.45 * near
      return {
        r: Math.round(100 * k),
        g: Math.round(255 * k),
        b: Math.round(160 * k),
      }
    }
    const lift = Math.round(180 * (1 - near))
    return { r: lift, g: lift, b: lift }
  }

  const { camX, camY } = cameraOffset(timeMs, animate)
  const cx = w * 0.5
  const cy = h * 0.5

  const screenOf = (n: MeshNode) => {
    const plane = MESH_DEPTH_PLANES[n.depth]!
    const x = n.x + camX * plane.parallax
    const y = n.y + camY * plane.parallax
    const s = plane.scale
    return { x: cx + (x - cx) * s, y: cy + (y - cy) * s }
  }

  if (animate) stepNodes(nodes, w, h)

  const byDepth: number[][] = MESH_DEPTH_PLANES.map(() => [])
  for (let i = 0; i < nodes.length; i++) {
    byDepth[nodes[i]!.depth]!.push(i)
  }

  const strokeEdge = (
    sa: { x: number; y: number },
    sb: { x: number; y: number },
    d: number,
    maxDist: number,
    edgeMul: number,
    alphaScale: number,
    t: number,
  ) => {
    // Softer distance falloff — links hang on longer before fading.
    const distFade = Math.pow(Math.max(0, 1 - d / maxDist), 0.65)
    const rim = Math.min(framePresence(sa.x, sa.y, w, h), framePresence(sb.x, sb.y, w, h))
    const alpha = distFade * edgeAlphaBase * edgeMul * alphaScale * rim
    if (alpha <= 0.004) return
    const { r, g, b } = dissolveRgb(t)
    ctx.beginPath()
    ctx.moveTo(sa.x, sa.y)
    ctx.lineTo(sb.x, sb.y)
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
    // Far a touch heavier so scaled-down webs still read; near Market-thin.
    ctx.lineWidth = 0.85 + (1 - t) * 0.45
    ctx.stroke()
  }

  // Same-depth meshes first (each layer is its own web).
  for (const depth of DEPTH_ORDER) {
    const idxs = byDepth[depth]!
    const plane = MESH_DEPTH_PLANES[depth]!
    const maxDist = plane.maxDist
    const t = depthT(depth)
    for (let a = 0; a < idxs.length; a++) {
      const ia = idxs[a]!
      const na = nodes[ia]!
      const sa = screenOf(na)
      for (let b = a + 1; b < idxs.length; b++) {
        const ib = idxs[b]!
        const nb = nodes[ib]!
        const sb = screenOf(nb)
        const dx = sa.x - sb.x
        const dy = sa.y - sb.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d >= maxDist) continue
        strokeEdge(sa, sb, d, maxDist, plane.edgeMul, 1, t)
      }
    }
  }

  // Faint bridges between adjacent depths — cross-depth edges without spiderweb.
  for (let depth = 0; depth < MESH_DEPTH_PLANES.length - 1; depth++) {
    const nearDepth = depth + ADJACENT_DEPTH_GAP
    const farIdxs = byDepth[depth]!
    const nearIdxs = byDepth[nearDepth]!
    const planeA = MESH_DEPTH_PLANES[depth]!
    const planeB = MESH_DEPTH_PLANES[nearDepth]!
    const edgeMul = (planeA.edgeMul + planeB.edgeMul) / 2
    const maxDist = Math.min(planeA.maxDist, planeB.maxDist) * BRIDGE_DIST_SCALE
    const t = (depthT(depth) + depthT(nearDepth)) / 2
    for (const ia of farIdxs) {
      const na = nodes[ia]!
      const sa = screenOf(na)
      for (const ib of nearIdxs) {
        const nb = nodes[ib]!
        const sb = screenOf(nb)
        const dx = sa.x - sb.x
        const dy = sa.y - sb.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d >= maxDist) continue
        strokeEdge(sa, sb, d, maxDist, edgeMul, BRIDGE_ALPHA_SCALE, t)
      }
    }
  }

  if (animate) {
    for (let p = pulses.length - 1; p >= 0; p--) {
      const pulse = pulses[p]!
      const from = nodes[pulse.fromIdx]
      const to = nodes[pulse.toIdx]
      if (!from || !to) {
        pulses.splice(p, 1)
        continue
      }
      const sf = screenOf(from)
      const st = screenOf(to)
      const t = (depthT(from.depth) + depthT(to.depth)) / 2
      const alphaMul =
        (MESH_DEPTH_PLANES[from.depth]!.alphaMul + MESH_DEPTH_PLANES[to.depth]!.alphaMul) / 2
      const { r, g, b } = dissolveRgb(t)
      const eased = Math.max(0, Math.min(1, pulse.ease(Math.min(1, pulse.progress))))
      const px = sf.x + (st.x - sf.x) * eased
      const py = sf.y + (st.y - sf.y) * eased
      const glow = 7 + 9 * t
      // Soft deliver close — rise and ease out (no hard snap at arrival).
      const close = Math.sin(eased * Math.PI)
      const rim = framePresence(px, py, w, h)
      if (rim <= 0.004) {
        pulse.progress += pulse.speed
        if (pulse.progress >= 1) pulses.splice(p, 1)
        continue
      }
      const aGlow = (dark ? 0.9 : 0.5) * alphaMul * close * rim
      const aMid = (dark ? 0.35 : 0.18) * alphaMul * close * rim

      const gradient = ctx.createRadialGradient(px, py, 0, px, py, glow)
      gradient.addColorStop(0, `rgba(${r},${g},${b},${aGlow})`)
      gradient.addColorStop(0.4, `rgba(${r},${g},${b},${aMid})`)
      gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.beginPath()
      ctx.arc(px, py, glow, 0, Math.PI * 2)
      ctx.fillStyle = gradient
      ctx.fill()

      ctx.beginPath()
      ctx.arc(px, py, 1.8 + 1.4 * t, 0, Math.PI * 2)
      ctx.fillStyle = dark
        ? `rgba(255,255,255,${0.9 * close * rim})`
        : `rgba(0,0,0,${0.75 * close * rim})`
      ctx.fill()

      pulse.progress += pulse.speed
      if (pulse.progress >= 1) pulses.splice(p, 1)
    }
  }

  // Nodes far → near so nearer peers read on top.
  for (const depth of DEPTH_ORDER) {
    const plane = MESH_DEPTH_PLANES[depth]!
    const t = depthT(depth)
    const { r, g, b } = dissolveRgb(t)
    for (const i of byDepth[depth]!) {
      const n = nodes[i]!
      const s = screenOf(n)
      const rim = framePresence(s.x, s.y, w, h)
      if (rim <= 0.004) continue
      ctx.beginPath()
      ctx.arc(s.x, s.y, n.radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${r},${g},${b},${nodeAlphaBase * plane.alphaMul * rim})`
      ctx.fill()
    }
  }
}
