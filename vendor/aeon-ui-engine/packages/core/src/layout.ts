/**
 * Responsive play-surface layout — logical coordinate plane + composition modes.
 *
 * Behavior stays in statecharts; **where** the user points is expressed in normalized
 * coordinates (0–100) inside a measured region, independent of CSS grid vs overlay.
 *
 * @see docs/LAYOUT_COORDINATES.md
 */

/** Point on the normalized plane (percent of region width/height). */
export type NormPoint = { readonly x: number; readonly y: number }

/** Axis-aligned bounds on the normalized plane (inclusive). */
export type NormRect = {
  readonly xMin: number
  readonly xMax: number
  readonly yMin: number
  readonly yMax: number
}

/** DOM mapping: y increases upward (throws, dice) vs downward (top-left UI). */
export type NormOrigin = 'bottom-left' | 'top-left'

export const NORM_PLANE = {
  bottomLeft: 'bottom-left',
  topLeft: 'top-left',
} as const satisfies Record<string, NormOrigin>

/** How regions are composed at a breakpoint — product maps to CSS grid / absolute. */
export type LayoutComposition = 'split' | 'stack' | 'overlay'

export interface RegionLayoutSlot {
  /** Logical region id (matches anatomy part or app constant). */
  readonly region: string
  /** Grid area name / slot id for CSS `grid-template-areas`. */
  readonly slot: string
  readonly zIndex?: number
}

export interface LayoutCompositionSpec {
  readonly id: string
  readonly composition: LayoutComposition
  readonly regions: readonly RegionLayoutSlot[]
  /** Interaction bounds per region in **that region's** normalized plane. */
  readonly bounds?: Readonly<Record<string, NormRect>>
}

export type LayoutMode = 'compact' | 'wide'

export interface ResponsiveLayoutSpec {
  readonly modes: {
    readonly compact: LayoutCompositionSpec
    readonly wide: LayoutCompositionSpec
  }
  /**
   * Media query that selects `compact` when matched (default: phone portrait).
   * When it does not match, mode is `wide`.
   */
  readonly compactMq?: string
}

export const DEFAULT_COMPACT_MQ = '(max-width: 39.99rem)'

export function clampNorm(point: NormPoint, bounds: NormRect): NormPoint {
  return {
    x: Math.min(bounds.xMax, Math.max(bounds.xMin, point.x)),
    y: Math.min(bounds.yMax, Math.max(bounds.yMin, point.y)),
  }
}

export function normFromClient(
  rect: DOMRectReadOnly,
  clientX: number,
  clientY: number,
  options?: { origin?: NormOrigin; bounds?: NormRect },
): NormPoint {
  const origin = options?.origin ?? NORM_PLANE.bottomLeft
  const w = rect.width || 1
  const h = rect.height || 1
  const x = ((clientX - rect.left) / w) * 100
  const yFromTop = (clientY - rect.top) / h
  const y =
    origin === NORM_PLANE.bottomLeft ? (1 - yFromTop) * 100 : yFromTop * 100
  const raw = { x, y }
  return options?.bounds ? clampNorm(raw, options.bounds) : raw
}

export function clientFromNorm(
  rect: DOMRectReadOnly,
  point: NormPoint,
  options?: { origin?: NormOrigin },
): { clientX: number; clientY: number } {
  const origin = options?.origin ?? NORM_PLANE.bottomLeft
  const w = rect.width || 1
  const h = rect.height || 1
  const clientX = rect.left + (point.x / 100) * w
  const yFromTop = origin === NORM_PLANE.bottomLeft ? 1 - point.y / 100 : point.y / 100
  const clientY = rect.top + yFromTop * h
  return { clientX, clientY }
}

/** Measure element; returns null if not connected. */
export function measureElement(el: Element | null | undefined): DOMRect | null {
  if (!el || !('getBoundingClientRect' in el)) return null
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect : null
}

/** Prefer a dedicated region rect; fall back to mat when lane not mounted. */
export function resolveRegionRect(
  primary: DOMRect | null | undefined,
  fallback: DOMRect | null | undefined,
): DOMRect | null {
  if (primary && primary.width > 0 && primary.height > 0) return primary
  if (fallback && fallback.width > 0 && fallback.height > 0) return fallback
  return null
}

export function matchLayoutMode(
  spec: ResponsiveLayoutSpec,
  mq: Pick<MediaQueryList, 'matches'> = getCompactMq(spec),
): LayoutMode {
  return mq.matches ? 'compact' : 'wide'
}

export function getCompactMq(spec: ResponsiveLayoutSpec): MediaQueryList {
  const query = spec.compactMq ?? DEFAULT_COMPACT_MQ
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { matches: false } as MediaQueryList
  }
  return window.matchMedia(query)
}

export function layoutCompositionForMode(
  spec: ResponsiveLayoutSpec,
  mode: LayoutMode,
): LayoutCompositionSpec {
  return spec.modes[mode]
}

export function regionBoundsForMode(
  spec: ResponsiveLayoutSpec,
  mode: LayoutMode,
  regionId: string,
): NormRect | undefined {
  return spec.modes[mode].bounds?.[regionId]
}

/**
 * Value for `data-aeon-layout-mode` on the mat root.
 * Pair with `data-aeon-layout-composition` from the active spec.
 */
export function layoutModeAttrs(mode: LayoutMode, composition: LayoutComposition): Record<string, string> {
  return {
    'data-aeon-layout-mode': mode,
    'data-aeon-layout-composition': composition,
  }
}

/** Spread a norm point inside bounds (keeps cluster off edges). */
export function insetNormCluster(
  point: NormPoint,
  bounds: NormRect,
  inset: { x?: number; y?: number } = {},
): NormPoint {
  const padX = inset.x ?? 0
  const padY = inset.y ?? 0
  const halfX = (bounds.xMax - bounds.xMin) / 2
  const halfY = (bounds.yMax - bounds.yMin) / 2
  const capX = Math.min(padX, halfX - 0.5)
  const capY = Math.min(padY, halfY - 0.5)
  return {
    x: Math.min(bounds.xMax - capX, Math.max(bounds.xMin + capX, point.x)),
    y: Math.min(bounds.yMax - capY, Math.max(bounds.yMin + capY, point.y)),
  }
}
