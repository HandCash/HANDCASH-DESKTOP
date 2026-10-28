import { useEffect, useRef } from 'react'

/**
 * Payment-mesh backdrop — same motion language as items-market /partners
 * (Devs) HeroBackground, driven by HandCash brand tokens instead of Tailwind.
 */

type MeshNode = {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

type Pulse = {
  fromIdx: number
  toIdx: number
  progress: number
  speed: number
  ease: (t: number) => number
}

const NODE_COUNT = 150
const MAX_DIST = 120
const NODE_DAMPING = 0.9982
const NODE_DRIFT = 0.055
const NODE_MAX_SPEED = 1.35
const PULSE_SPEED_MIN = 0.01
const PULSE_SPEED_MAX = 0.035
const MAX_PULSES = 18
const PULSE_SPAWN_INTERVAL = 10
const SPLIT_CHANCE = 0.28
const SPLIT_COUNT_MIN = 3
const SPLIT_COUNT_MAX = 6

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4
const easeInQuart = (t: number) => t ** 4
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
const easeOutBack = (t: number) => {
  const c1 = 1.2
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
const easings = [easeOutQuart, easeInQuart, easeInOutCubic, easeOutBack]

function readMeshTone(): {
  dark: boolean
  r: number
  g: number
  b: number
} {
  const root = document.documentElement
  const dark = root.getAttribute('data-aeon-mode') !== 'light'
  if (dark) {
    // Neon brand green — matches partners dark mesh.
    return { dark: true, r: 100, g: 255, b: 160 }
  }
  return { dark: false, r: 0, g: 0, b: 0 }
}

export function AuthMeshBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<MeshNode[]>([])
  const pulsesRef = useRef<Pulse[]>([])
  const frameCountRef = useRef(0)
  const rafRef = useRef(0)
  const toneRef = useRef(readMeshTone())

  useEffect(() => {
    const syncTone = () => {
      toneRef.current = readMeshTone()
    }
    syncTone()
    const observer = new MutationObserver(syncTone)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-aeon-mode', 'class'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const parent = canvas.parentElement
      const w = parent?.clientWidth ?? canvas.offsetWidth
      const h = parent?.clientHeight ?? canvas.offsetHeight
      canvas.width = Math.max(1, w)
      canvas.height = Math.max(1, h)
    }
    resize()
    window.addEventListener('resize', resize)

    nodesRef.current = Array.from({ length: NODE_COUNT }, () => ({
      x: Math.random() * Math.max(canvas.width, 1),
      y: Math.random() * Math.max(canvas.height, 1),
      vx: (Math.random() - 0.5) * 1.4,
      vy: (Math.random() - 0.5) * 1.4,
      radius: Math.random() * 1.2 + 0.6,
    }))

    const draw = () => {
      const w = canvas.width
      const h = canvas.height
      const nodes = nodesRef.current
      const pulses = pulsesRef.current
      const { dark, r: meshR, g: meshG, b: meshB } = toneRef.current

      ctx.clearRect(0, 0, w, h)

      const edgeAlphaMul = dark ? 0.32 : 0.28
      const nodeAlpha = dark ? 0.5 : 0.38
      const pulseCore = dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.75)'

      for (const n of nodes) {
        n.vx *= NODE_DAMPING
        n.vy *= NODE_DAMPING
        n.vx += (Math.random() - 0.5) * NODE_DRIFT
        n.vy += (Math.random() - 0.5) * NODE_DRIFT

        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
        if (speed > NODE_MAX_SPEED) {
          n.vx = (n.vx / speed) * NODE_MAX_SPEED
          n.vy = (n.vy / speed) * NODE_MAX_SPEED
        }

        n.x += n.vx
        n.y += n.vy

        if (n.x < 0) {
          n.x = 0
          n.vx = Math.abs(n.vx)
        }
        if (n.x > w) {
          n.x = w
          n.vx = -Math.abs(n.vx)
        }
        if (n.y < 0) {
          n.y = 0
          n.vy = Math.abs(n.vy)
        }
        if (n.y > h) {
          n.y = h
          n.vy = -Math.abs(n.vy)
        }
      }

      frameCountRef.current += 1
      if (frameCountRef.current % PULSE_SPAWN_INTERVAL === 0 && pulses.length < MAX_PULSES) {
        const fromIdx = Math.floor(Math.random() * nodes.length)
        const from = nodes[fromIdx]!

        const isSplit = Math.random() < SPLIT_CHANCE
        const numTargets = isSplit
          ? SPLIT_COUNT_MIN +
            Math.floor(Math.random() * (SPLIT_COUNT_MAX - SPLIT_COUNT_MIN + 1))
          : 1

        const used = new Set<number>([fromIdx])
        for (let t = 0; t < numTargets && pulses.length < MAX_PULSES; t++) {
          let toIdx = Math.floor(Math.random() * nodes.length)
          for (let tries = 0; used.has(toIdx) && tries < 20; tries++) {
            toIdx = Math.floor(Math.random() * nodes.length)
          }
          used.add(toIdx)
          const to = nodes[toIdx]!
          const dist = Math.hypot(from.x - to.x, from.y - to.y)
          if (dist < MAX_DIST * 1.6) {
            const speed =
              PULSE_SPEED_MIN + Math.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN)
            pulses.push({
              fromIdx,
              toIdx,
              progress: 0,
              speed,
              ease: easings[Math.floor(Math.random() * easings.length)]!,
            })
          }
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < MAX_DIST) {
            const alpha = (1 - d / MAX_DIST) * edgeAlphaMul
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.strokeStyle = `rgba(${meshR},${meshG},${meshB},${alpha})`
            ctx.lineWidth = 1
            ctx.stroke()
          }
        }
      }

      for (let p = pulses.length - 1; p >= 0; p--) {
        const pulse = pulses[p]!
        const from = nodes[pulse.fromIdx]!
        const to = nodes[pulse.toIdx]!
        const eased = Math.max(0, Math.min(1, pulse.ease(Math.min(1, pulse.progress))))
        const px = from.x + (to.x - from.x) * eased
        const py = from.y + (to.y - from.y) * eased

        const gradient = ctx.createRadialGradient(px, py, 0, px, py, 14)
        gradient.addColorStop(0, `rgba(${meshR},${meshG},${meshB},${dark ? 0.95 : 0.55})`)
        gradient.addColorStop(0.4, `rgba(${meshR},${meshG},${meshB},${dark ? 0.4 : 0.22})`)
        gradient.addColorStop(1, `rgba(${meshR},${meshG},${meshB},0)`)
        ctx.beginPath()
        ctx.arc(px, py, 14, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()

        ctx.beginPath()
        ctx.arc(px, py, 3, 0, Math.PI * 2)
        ctx.fillStyle = pulseCore
        ctx.fill()

        pulse.progress += pulse.speed
        if (pulse.progress >= 1) pulses.splice(p, 1)
      }

      for (const n of nodes) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${meshR},${meshG},${meshB},${nodeAlpha})`
        ctx.fill()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      data-aeon-part="mesh"
      className="auth-mesh-canvas"
      aria-hidden
    />
  )
}
