/**
 * Full-bleed entry background — Items Market soft elastic mesh reverse-
 * decomposed under one chart (`entryMeshMachine` owns 5 parallax planes via
 * context.layerCount + play/static/paused). Step/paint stay pure in
 * `entryMeshMotion`. HandCash brand green; not coins, not purple.
 */
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect, useRef } from 'react'
import { entryMeshMachine } from '../../machines/entryMeshMachine'
import {
  DEPTH_LAYER_COUNT,
  MAX_PULSES,
  PULSE_SPAWN_INTERVAL,
  TOTAL_MESH_NODES,
  paintFrame,
  prefersReducedMotion,
  seedNodes,
  spawnPulses,
  type MeshNode,
  type MeshPulse,
} from './entryMeshMotion'

export {
  CAM_AMP_X,
  DEPTH_LAYER_COUNT,
  MESH_DEPTH_PLANES,
  buildMeshDepthPlanes,
} from './entryMeshMotion'

type MeshPhase = 'booting' | 'static' | 'playing' | 'paused'

function meshMode(snap: { matches: (s: MeshPhase) => boolean }): MeshPhase {
  if (snap.matches('playing')) return 'playing'
  if (snap.matches('paused')) return 'paused'
  if (snap.matches('static')) return 'static'
  return 'booting'
}

export function AuthEntryField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<MeshNode[]>([])
  const pulsesRef = useRef<MeshPulse[]>([])
  const sizeRef = useRef({ w: 1, h: 1 })
  const startRef = useRef(0)
  const frameCountRef = useRef(0)
  const [snap, send] = useMachine(entryMeshMachine)
  const mode = meshMode(snap)
  const phase = stateToAttr(snap.value)

  useEffect(() => {
    if (mode !== 'booting') return
    send(prefersReducedMotion() ? { type: 'BOOT_STATIC' } : { type: 'BOOT_PLAY' })
  }, [mode, send])

  // Entry drag must not start a text selection (I-beam) over the mesh.
  useEffect(() => {
    const block = (e: Event) => {
      e.preventDefault()
    }
    document.addEventListener('selectstart', block)
    return () => document.removeEventListener('selectstart', block)
  }, [])

  useEffect(() => {
    if (mode === 'booting' || mode === 'static') return
    const canvas = canvasRef.current
    if (!canvas) return

    const sync = () => {
      const docHidden = typeof document !== 'undefined' && document.hidden
      const rect = canvas.getBoundingClientRect()
      const vh = typeof window !== 'undefined' ? window.innerHeight : 0
      const vw = typeof window !== 'undefined' ? window.innerWidth : 0
      const off = rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw
      if (docHidden || off) send({ type: 'HIDE' })
      else send({ type: 'SHOW' })
    }

    document.addEventListener('visibilitychange', sync)
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(sync, { threshold: 0 })
        : null
    io?.observe(canvas)
    sync()
    return () => {
      document.removeEventListener('visibilitychange', sync)
      io?.disconnect()
    }
  }, [mode, send])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      if (mq.matches) send({ type: 'REDUCE' })
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [send])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || mode === 'booting') return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const parent = canvas.parentElement
      // Prefer parent; fall back to window so a late-layout parent never leaves a 1×1 seed.
      const w = Math.max(
        parent?.clientWidth ?? 0,
        canvas.offsetWidth,
        typeof window !== 'undefined' ? window.innerWidth : 0,
        1,
      )
      const h = Math.max(
        parent?.clientHeight ?? 0,
        canvas.offsetHeight,
        typeof window !== 'undefined' ? window.innerHeight : 0,
        1,
      )
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const prev = sizeRef.current
      sizeRef.current = { w, h }
      // Reseed when we grow out of a tiny first layout (nodes stuck in a corner).
      if (
        nodesRef.current.length > 0 &&
        prev.w > 0 &&
        prev.h > 0 &&
        prev.w * prev.h < 20_000 &&
        w * h > prev.w * prev.h * 4
      ) {
        nodesRef.current = seedNodes(w, h)
        pulsesRef.current = []
      }
      return { w, h }
    }

    let { w, h } = resize()
    // Reseed when density/layer knobs change (HMR or remount).
    const expect = TOTAL_MESH_NODES
    if (
      nodesRef.current.length !== expect ||
      nodesRef.current.some((n) => n.depth >= DEPTH_LAYER_COUNT)
    ) {
      nodesRef.current = seedNodes(w, h)
      pulsesRef.current = []
      startRef.current = performance.now()
      frameCountRef.current = 0
    }

    const onResize = () => {
      ;({ w, h } = resize())
      for (const n of nodesRef.current) {
        n.x = Math.min(Math.max(n.x, 0), w)
        n.y = Math.min(Math.max(n.y, 0), h)
      }
      if (mode !== 'playing') {
        paintFrame(ctx, w, h, nodesRef.current, pulsesRef.current, false, 0)
      }
    }

    window.addEventListener('resize', onResize)
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    if (canvas.parentElement) ro?.observe(canvas.parentElement)

    if (mode !== 'playing') {
      paintFrame(ctx, w, h, nodesRef.current, pulsesRef.current, false, 0)
      return () => {
        window.removeEventListener('resize', onResize)
        ro?.disconnect()
      }
    }

    let raf = 0
    let alive = true
    const draw = (now: number) => {
      if (!alive) return
      frameCountRef.current += 1
      if (
        frameCountRef.current % PULSE_SPAWN_INTERVAL === 0 &&
        pulsesRef.current.length < MAX_PULSES
      ) {
        spawnPulses(nodesRef.current, pulsesRef.current)
      }
      const size = sizeRef.current
      paintFrame(
        ctx,
        size.w,
        size.h,
        nodesRef.current,
        pulsesRef.current,
        true,
        now - startRef.current,
      )
      raf = requestAnimationFrame(draw)
    }
    draw(performance.now())

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
    }
  }, [mode, TOTAL_MESH_NODES, DEPTH_LAYER_COUNT])

  return (
    <canvas
      ref={canvasRef}
      className="auth-entry-field"
      data-aeon-scope="entry-mesh"
      data-aeon-part="entry-field"
      data-aeon-state={phase}
      aria-hidden="true"
    />
  )
}
