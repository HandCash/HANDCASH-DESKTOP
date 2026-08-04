import { setup, type ActorRefFrom, type AnyStateMachine, type SnapshotFrom } from 'xstate'

/** Re-export XState setup — encode UI behavior as executable statecharts. */
export { setup as createAeonMachine }

export type AeonSnapshot<M extends AnyStateMachine> = SnapshotFrom<M>
export type AeonActor<M extends AnyStateMachine> = ActorRefFrom<M>

/** Flatten nested state value for data-aeon-state attribute. */
export function stateToAttr(value: unknown): string {
  if (value == null || typeof value === 'string') return String(value ?? '')
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}:${stateToAttr(v)}`)
    .join(' ')
}

/**
 * Primary visual face for parallel field charts — same hierarchy as Button/Dialog:
 * one leaf on `data-aeon-state`, not a region dump.
 * Priority: pending > invalid > dirty > idle.
 */
export type FieldFace = 'idle' | 'dirty' | 'invalid' | 'pending'

export function fieldFace(value: unknown): FieldFace {
  if (value == null || typeof value !== 'object') return 'idle'
  const v = value as Record<string, unknown>
  if (v.submission === 'pending') return 'pending'
  if (v.validation === 'invalid') return 'invalid'
  if (v.interaction === 'dirty') return 'dirty'
  return 'idle'
}

/** Orthogonal field regions for advanced CSS (`data-aeon-interaction`, etc.). */
export function fieldRegions(value: unknown): {
  interaction: string
  validation: string
  submission: string
} {
  if (value == null || typeof value !== 'object') {
    return { interaction: 'pristine', validation: 'valid', submission: 'idle' }
  }
  const v = value as Record<string, unknown>
  return {
    interaction: typeof v.interaction === 'string' ? v.interaction : 'pristine',
    validation: typeof v.validation === 'string' ? v.validation : 'valid',
    submission: typeof v.submission === 'string' ? v.submission : 'idle',
  }
}

/** Read one region from a (possibly parallel) snapshot value. */
export function getRegionValue(value: unknown, region: string): unknown {
  if (value == null) return undefined
  if (typeof value === 'string') return value === region ? value : undefined
  if (typeof value === 'object') {
    return (value as Record<string, unknown>)[region]
  }
  return undefined
}

/**
 * Active path under a region — e.g. `{ deck: { ready: 'matched' } }` →
 * `regionPath(v, 'deck')` → `['ready', 'matched']`.
 */
export function regionPath(value: unknown, region: string): string[] {
  const path: string[] = []
  let cur: unknown = getRegionValue(value, region)
  while (cur != null) {
    if (typeof cur === 'string') {
      path.push(cur)
      break
    }
    if (typeof cur !== 'object') break
    const entries = Object.entries(cur as Record<string, unknown>)
    if (entries.length === 0) break
    if (entries.length > 1) {
      path.push(entries.map(([k]) => k).sort().join('+'))
      break
    }
    const [key, next] = entries[0]!
    path.push(key)
    cur = next
  }
  return path
}

/** Deepest active key under a region (`['ready','matched']` → `'matched'`). */
export function regionLeaf(value: unknown, region: string): string | undefined {
  const path = regionPath(value, region)
  return path[path.length - 1]
}

/** True when the region path equals or ends with the given leaf / path prefix. */
export function regionMatches(
  value: unknown,
  region: string,
  match: string | readonly string[],
): boolean {
  const path = regionPath(value, region)
  if (path.length === 0) return false
  if (typeof match === 'string') {
    return path.includes(match) || path[path.length - 1] === match
  }
  if (match.length === 0) return false
  if (match.length <= path.length) {
    return match.every((part, i) => path[i] === part)
  }
  return false
}
