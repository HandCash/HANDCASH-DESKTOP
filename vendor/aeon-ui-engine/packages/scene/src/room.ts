import type { SceneUnit } from './transform.js'

/** Width × height × depth of a box room (px). */
export type SceneRoomSize = {
  width: number
  height: number
  depth: number
}

export type SceneRoomCamera = {
  /** Look-down angle on the whole room (degrees). */
  pitch?: number
  /** Turn the room (degrees). */
  yaw?: number
  /** Push room back from the viewer (px). */
  offsetZ?: number
  /** Vertical anchor of the room in the stage (0–100%). */
  anchorY?: SceneUnit
}

/** CSS variables consumed by `.aeon-scene-room*` in scene-room.css */
export function sceneRoomVars(
  size: SceneRoomSize,
  camera: SceneRoomCamera = {},
): Record<string, string> {
  const pitch = camera.pitch ?? 10
  const yaw = camera.yaw ?? 0
  const offsetZ = camera.offsetZ ?? -120
  const anchorY = camera.anchorY ?? '46%'

  return {
    '--aeon-room-w': `${size.width}px`,
    '--aeon-room-h': `${size.height}px`,
    '--aeon-room-d': `${size.depth}px`,
    '--aeon-room-pitch': `${pitch}deg`,
    '--aeon-room-yaw': `${yaw}deg`,
    '--aeon-room-offset-z': `${offsetZ}px`,
    '--aeon-room-anchor-y': typeof anchorY === 'number' ? `${anchorY}px` : anchorY,
  }
}
