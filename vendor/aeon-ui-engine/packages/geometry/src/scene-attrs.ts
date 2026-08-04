import { scopeAttrs } from '@aeon-ui/core'

export type SceneState = 'idle' | 'active' | 'paused'

/** `data-aeon-scope="scene"` for ambient regions (backdrops, visualizers). */
export function sceneAttrs(
  part: string,
  state?: SceneState,
): Record<string, unknown> {
  return scopeAttrs('scene', part, state ? { state } : undefined)
}
