export type SceneUnit = number | `${number}%` | `${number}px` | `${number}rem` | `${number}vh` | `${number}vw`

/** Layer transform in CSS 3D (degrees for rotation). */
export type SceneTransform3d = {
  x?: SceneUnit
  y?: SceneUnit
  z?: number
  rotateX?: number
  rotateY?: number
  rotateZ?: number
  scale?: number
}

export type ScenePerspective = {
  distance?: number
  origin?: string
}

export function formatSceneUnit(value: SceneUnit | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value === 'number') return `${value}px`
  return value
}

/** Build `transform` + `transform-origin` for a scene layer. */
export function sceneTransformStyle(
  transform: SceneTransform3d,
  options?: { origin?: string; preserve3d?: boolean },
): Record<string, string> {
  const x = formatSceneUnit(transform.x, '0')
  const y = formatSceneUnit(transform.y, '0')
  const z = transform.z ?? 0
  const parts: string[] = [`translate3d(${x}, ${y}, ${z}px)`]

  if (transform.rotateX) parts.push(`rotateX(${transform.rotateX}deg)`)
  if (transform.rotateY) parts.push(`rotateY(${transform.rotateY}deg)`)
  if (transform.rotateZ) parts.push(`rotateZ(${transform.rotateZ}deg)`)
  if (transform.scale != null) parts.push(`scale(${transform.scale})`)

  const style: Record<string, string> = { transform: parts.join(' ') }
  if (options?.origin) style.transformOrigin = options.origin
  if (options?.preserve3d !== false) style.transformStyle = 'preserve-3d'
  return style
}

/** Perspective on a stage root (apply to the element that wraps all layers). */
export function sceneStageStyle(perspective: ScenePerspective = {}): Record<string, string> {
  return {
    perspective: `${perspective.distance ?? 1100}px`,
    perspectiveOrigin: perspective.origin ?? '50% 42%',
    transformStyle: 'preserve-3d',
  }
}

/** Wall trapezoid clip — left or right alley wall. */
export function sceneWallClip(side: 'left' | 'right'): string {
  return side === 'left'
    ? 'polygon(0 100%, 0 5%, 78% 0, 100% 100%)'
    : 'polygon(100% 100%, 100% 5%, 22% 0, 0 100%)'
}
