import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
/** Fixed button / wheel step — no variable intensity. */
const ZOOM_STEP = 1.15
const FIT_PADDING = 24
const DRAG_CLICK_MAX_PX = 6

function ensureMermaid(mermaid: typeof import('mermaid').default) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    htmlLabels: true,
    wrap: true,
    fontFamily: 'IBM Plex Sans, Instrument Sans, system-ui, sans-serif',
    themeVariables: {
      fontFamily: 'IBM Plex Sans, Instrument Sans, system-ui, sans-serif',
      fontSize: '13px',
      primaryColor: '#1a2420',
      primaryTextColor: '#e8f5ef',
      primaryBorderColor: '#38d385',
      lineColor: '#8b9a92',
      secondaryColor: '#121a16',
      tertiaryColor: '#0c1210',
      noteBkgColor: '#15201a',
      noteTextColor: '#c5d4cb',
      noteBorderColor: '#2a3d34',
    },
    flowchart: {
      useMaxWidth: false,
      htmlLabels: true,
      wrappingWidth: 160,
      padding: 16,
      nodeSpacing: 48,
      rankSpacing: 56,
    },
    state: {
      useMaxWidth: false,
      nodeSpacing: 56,
      rankSpacing: 60,
      fontSize: 13,
      textHeight: 18,
      padding: 18,
      dividerMargin: 10,
      labelHeight: 20,
      fontSizeFactor: 7.2,
    },
  })
}

function scrubOrphanMermaidNodes(keepRoot?: HTMLElement | null) {
  const nodes = document.querySelectorAll(
    'body > svg[id^="hc-mmd-"], body > svg[id^="d"], body > div[id^="d"], body > div[id^="hc-mmd-"]',
  )
  for (const node of nodes) {
    if (keepRoot && keepRoot.contains(node)) continue
    node.remove()
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

const LABEL_FONT =
  "600 13px 'IBM Plex Sans', 'Instrument Sans', system-ui, sans-serif"
const BOX_PAD_X = 14
const BOX_PAD_Y = 16

function fitStateBoxes(root: HTMLElement) {
  root.querySelectorAll('text').forEach((t) => {
    const el = t as SVGTextElement
    el.setAttribute('font-family', "'IBM Plex Sans', 'Instrument Sans', system-ui, sans-serif")
    if (!el.getAttribute('font-size')) el.setAttribute('font-size', '13')
    el.style.font = LABEL_FONT
  })

  root.querySelectorAll('foreignObject').forEach((node) => {
    const fo = node as SVGForeignObjectElement
    const div = fo.querySelector('div')
    if (!div) return
    div.style.font = LABEL_FONT
    div.style.lineHeight = '1.35'
    div.style.whiteSpace = 'normal'
    div.style.overflowWrap = 'anywhere'
    div.style.wordBreak = 'break-word'
    div.style.boxSizing = 'border-box'
    div.style.padding = '2px 4px'
    div.style.margin = '0'
    div.style.overflow = 'visible'
    div.style.height = 'auto'
    div.style.maxHeight = 'none'

    const w = Math.max(
      Math.ceil(div.scrollWidth),
      Math.ceil(div.getBoundingClientRect().width),
      Number(fo.getAttribute('width')) || 0,
    )
    const h = Math.max(
      Math.ceil(div.scrollHeight),
      Math.ceil(div.offsetHeight),
      Math.ceil(div.getBoundingClientRect().height),
      18,
    )
    if (w > 0) fo.setAttribute('width', String(w))
    fo.setAttribute('height', String(h + 4))
    fo.style.overflow = 'visible'
  })

  root.querySelectorAll('g.node').forEach((g) => {
    const group = g as SVGGElement
    if (group.querySelector('circle.state-start, circle.state-end, .fork-join')) return

    const rect =
      group.querySelector(
        ':scope > rect.label-container, :scope > rect.basic, :scope > g > rect.outer, :scope > g > rect, :scope > rect',
      ) ?? null
    if (!rect) return

    const label = group.querySelector(':scope > g.label')
    let contentBox: { x: number; y: number; width: number; height: number } | null = null
    try {
      if (label) {
        contentBox = (label as SVGGElement).getBBox()
      } else {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const child of group.children) {
          if (child === rect || child.tagName === 'rect') continue
          try {
            const b = (child as SVGGraphicsElement).getBBox()
            if (!b.width && !b.height) continue
            minX = Math.min(minX, b.x)
            minY = Math.min(minY, b.y)
            maxX = Math.max(maxX, b.x + b.width)
            maxY = Math.max(maxY, b.y + b.height)
          } catch {
            /* ignore */
          }
        }
        if (Number.isFinite(minX)) {
          contentBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        }
      }
    } catch {
      contentBox = null
    }
    if (!contentBox || contentBox.height < 1) return

    const curW = Number(rect.getAttribute('width')) || 0
    const curH = Number(rect.getAttribute('height')) || 0
    const nextW = Math.max(curW, contentBox.width + BOX_PAD_X * 2)
    const nextH = Math.max(curH, contentBox.height + BOX_PAD_Y * 2)
    const finalX = contentBox.x + contentBox.width / 2 - nextW / 2
    const finalY = contentBox.y - BOX_PAD_Y
    const finalH = Math.max(nextH, contentBox.height + BOX_PAD_Y * 2)

    if (!Number.isFinite(finalX) || !Number.isFinite(finalY) || !Number.isFinite(nextW) || !Number.isFinite(finalH)) {
      return
    }

    rect.setAttribute('x', String(finalX))
    rect.setAttribute('y', String(finalY))
    rect.setAttribute('width', String(Math.ceil(nextW)))
    rect.setAttribute('height', String(Math.ceil(finalH)))

    const divider = group.querySelector(
      ':scope > line.divider, :scope > g > line.divider, :scope > line.descr-divider',
    )
    if (divider) {
      divider.setAttribute('x1', String(finalX))
      divider.setAttribute('x2', String(finalX + nextW))
    }
  })
}

/** Lock SVG to intrinsic content size once — zoom is CSS transform only. */
function lockNaturalSize(svgEl: SVGSVGElement): { w: number; h: number } {
  svgEl.removeAttribute('style')
  svgEl.style.maxWidth = 'none'
  svgEl.style.maxHeight = 'none'

  let w = 0
  let h = 0
  try {
    const box = svgEl.getBBox()
    if (box.width > 1 && box.height > 1) {
      const pad = 12
      w = Math.ceil(box.width + pad * 2)
      h = Math.ceil(box.height + pad * 2)
      svgEl.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${w} ${h}`)
    }
  } catch {
    /* fall through */
  }

  if (!w || !h) {
    const vb = svgEl.viewBox?.baseVal
    if (vb && vb.width > 1 && vb.height > 1) {
      w = vb.width
      h = vb.height
    } else {
      w = 480
      h = 320
      svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
  }

  svgEl.setAttribute('width', String(w))
  svgEl.setAttribute('height', String(h))
  svgEl.style.width = `${w}px`
  svgEl.style.height = `${h}px`
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  return { w, h }
}

/** Mermaid domId is `state-<id>-<n>` (notes: `state-<id>----note-<n>`). */
function extractStateId(el: Element): string | null {
  const dataId = el.getAttribute('data-id')
  if (dataId && dataId !== 'root') return dataId
  const id = el.getAttribute('id') || ''
  const m = id.match(/^state-(.+?)(?:----\w+)?-\d+$/)
  if (m?.[1] && m[1] !== 'root') return m[1]
  return null
}

function wireNavigableStates(
  root: HTMLElement,
  navigableIds: ReadonlySet<string>,
  onNavigate: (pageId: string) => void,
): () => void {
  root.querySelectorAll('g.node').forEach((g) => {
    const group = g as SVGGElement
    if (group.querySelector('circle.state-start, circle.state-end, .fork-join')) return
    const stateId = extractStateId(group)
    if (!stateId || !navigableIds.has(stateId)) {
      group.classList.remove('is-navigable')
      group.removeAttribute('data-statechart-link')
      group.style.cursor = ''
      return
    }
    group.classList.add('is-navigable')
    group.style.cursor = 'pointer'
    group.setAttribute('data-statechart-link', stateId)
    group.setAttribute('role', 'link')
    group.setAttribute('tabindex', '0')
    group.setAttribute('aria-label', `Open ${stateId} statechart`)
  })

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (!target) return
    const link = target.closest('[data-statechart-link]') as HTMLElement | null
    if (!link || !root.contains(link)) return
    const pageId = link.getAttribute('data-statechart-link')
    if (!pageId) return
    e.preventDefault()
    e.stopPropagation()
    onNavigate(pageId)
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

type Props = {
  source: string
  title?: string
  /** Page ids that exist in the statecharts nav — clicking those states opens them. */
  navigableIds?: ReadonlySet<string>
  onNavigateState?: (pageId: string) => void
}

/** Mermaid state diagram — transform zoom/pan; clickable linked states. */
export function MermaidDiagram({ source, title, navigableIds, onNavigateState }: Props) {
  const reactId = useId().replace(/:/g, '')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const naturalRef = useRef({ w: 1, h: 1 })
  const userAdjustedRef = useRef(false)
  const lastViewportRef = useRef({ w: 0, h: 0 })
  const sizedRef = useRef(false)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const wheelLockRef = useRef(false)
  const navigateRef = useRef(onNavigateState)
  navigateRef.current = onNavigateState

  const applyView = useCallback((nextZoom: number, nextPan: { x: number; y: number }) => {
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    zoomRef.current = z
    panRef.current = nextPan
    setZoom(z)
    setPan(nextPan)
  }, [])

  const fitEntire = useCallback(() => {
    const viewport = viewportRef.current
    const stage = stageRef.current
    if (!viewport || !stage) return
    const svgEl = stage.querySelector('svg')
    if (!svgEl) return

    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    if (vw < 48 || vh < 48) return

    lastViewportRef.current = { w: vw, h: vh }
    fitStateBoxes(stage)
    naturalRef.current = lockNaturalSize(svgEl)
    sizedRef.current = true

    const { w, h } = naturalRef.current
    const availW = Math.max(40, vw - FIT_PADDING * 2)
    const availH = Math.max(40, vh - FIT_PADDING * 2)
    const nextZoom = clamp(Math.min(availW / w, availH / h), MIN_ZOOM, MAX_ZOOM)
    applyView(nextZoom, {
      x: Math.round((vw - w * nextZoom) / 2),
      y: Math.round((vh - h * nextZoom) / 2),
    })
  }, [applyView])

  useEffect(() => {
    let cancelled = false
    userAdjustedRef.current = false
    sizedRef.current = false
    naturalRef.current = { w: 1, h: 1 }
    lastViewportRef.current = { w: 0, h: 0 }
    setSvg(null)
    setError(null)
    zoomRef.current = 1
    panRef.current = { x: 0, y: 0 }
    setZoom(1)
    setPan({ x: 0, y: 0 })
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        ensureMermaid(mermaid)
        const host = hostRef.current
        const renderId = `hc-mmd-${reactId}-${Date.now().toString(36)}`
        const { svg: rendered } = host
          ? await mermaid.render(renderId, source, host)
          : await mermaid.render(renderId, source)
        if (!cancelled) {
          setSvg(rendered)
          setError(null)
          scrubOrphanMermaidNodes(host)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Diagram failed to render')
          setSvg(null)
          scrubOrphanMermaidNodes(hostRef.current)
        }
      }
    })()
    return () => {
      cancelled = true
      scrubOrphanMermaidNodes(hostRef.current)
    }
  }, [source, reactId])

  useEffect(() => {
    if (!svg) return
    const viewport = viewportRef.current
    const stage = stageRef.current
    if (!viewport || !stage) return

    let cancelled = false

    const prepare = (forceFit: boolean) => {
      if (cancelled) return
      const svgEl = stage.querySelector('svg')
      if (!svgEl) return
      fitStateBoxes(stage)
      if (!sizedRef.current) {
        naturalRef.current = lockNaturalSize(svgEl)
        sizedRef.current = true
      }
      // Never rewrite SVG pixel size after the first lock — zoom is CSS scale only.
      if (forceFit || !userAdjustedRef.current) {
        // Re-measure content once when fitting so taller labels are included.
        naturalRef.current = lockNaturalSize(svgEl)
        fitEntire()
      }
    }

    const t0 = requestAnimationFrame(() => {
      prepare(true)
      requestAnimationFrame(() => prepare(true))
    })
    const fontTimer = window.setTimeout(() => prepare(!userAdjustedRef.current), 220)
    const fontsReady =
      'fonts' in document
        ? document.fonts.ready.then(() => {
            if (!cancelled && !userAdjustedRef.current) prepare(true)
          })
        : null
    void fontsReady

    const ro = new ResizeObserver(() => {
      const vw = viewport.clientWidth
      const vh = viewport.clientHeight
      const prev = lastViewportRef.current
      if (Math.abs(vw - prev.w) < 2 && Math.abs(vh - prev.h) < 2) return
      lastViewportRef.current = { w: vw, h: vh }
      if (userAdjustedRef.current) return
      fitEntire()
    })
    ro.observe(viewport)

    return () => {
      cancelled = true
      cancelAnimationFrame(t0)
      window.clearTimeout(fontTimer)
      ro.disconnect()
    }
  }, [svg, fitEntire])

  // Wire clickable states after SVG mounts / navigable set changes.
  useEffect(() => {
    if (!svg || !navigableIds?.size || !onNavigateState) return
    const stage = stageRef.current
    if (!stage) return

    let unwire = wireNavigableStates(stage, navigableIds, (pageId) => {
      navigateRef.current?.(pageId)
    })
    // Labels settle after first paint — re-mark clickable nodes.
    const t = window.setTimeout(() => {
      unwire()
      unwire = wireNavigableStates(stage, navigableIds, (pageId) => {
        navigateRef.current?.(pageId)
      })
    }, 250)

    return () => {
      window.clearTimeout(t)
      unwire()
    }
  }, [svg, navigableIds, onNavigateState])

  const zoomBy = useCallback(
    (factor: number) => {
      userAdjustedRef.current = true
      const viewport = viewportRef.current
      const prev = zoomRef.current
      const z = clamp(prev * factor, MIN_ZOOM, MAX_ZOOM)
      if (Math.abs(z - prev) < 0.001) return

      if (!viewport) {
        applyView(z, panRef.current)
        return
      }
      // Keep the viewport center fixed in diagram space.
      const cx = viewport.clientWidth / 2
      const cy = viewport.clientHeight / 2
      applyView(z, {
        x: Math.round(cx - ((cx - panRef.current.x) / prev) * z),
        y: Math.round(cy - ((cy - panRef.current.y) / prev) * z),
      })
    },
    [applyView],
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el || !svg) return
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // One discrete step per gesture burst — stops trackpad chaos.
      if (wheelLockRef.current) return
      wheelLockRef.current = true
      window.setTimeout(() => {
        wheelLockRef.current = false
      }, 80)
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [svg, zoomBy])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Don't start pan when clicking a navigable state (let click fire).
    const t = e.target as Element | null
    if (t?.closest?.('[data-statechart-link]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: panRef.current.x,
      originY: panRef.current.y,
      moved: false,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && dx * dx + dy * dy > DRAG_CLICK_MAX_PX * DRAG_CLICK_MAX_PX) {
      drag.moved = true
      userAdjustedRef.current = true
    }
    if (!drag.moved) return
    const nextPan = {
      x: Math.round(drag.originX + dx),
      y: Math.round(drag.originY + dy),
    }
    panRef.current = nextPan
    setPan(nextPan)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const onFitClick = () => {
    userAdjustedRef.current = false
    fitEntire()
  }

  return (
    <figure className="statechart-figure" data-aeon-part="mermaid">
      {title ? <figcaption className="sr-only">{title}</figcaption> : null}
      <div ref={hostRef} className="statechart-mermaid-host" aria-hidden />

      <div className="statechart-zoom-bar" role="toolbar" aria-label="Diagram zoom">
        <button
          type="button"
          className="statechart-zoom-btn"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <span className="statechart-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="statechart-zoom-btn"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="statechart-zoom-btn"
          title="Fit entire chart in view"
          aria-label="Fit entire chart in view"
          onClick={onFitClick}
        >
          Fit
        </button>
      </div>

      {error ? (
        <pre className="statechart-error">{error}</pre>
      ) : svg ? (
        <div
          ref={viewportRef}
          className="statechart-panzoom"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            ref={stageRef}
            className="statechart-mermaid"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : (
        <p className="statechart-loading">Rendering…</p>
      )}
    </figure>
  )
}
