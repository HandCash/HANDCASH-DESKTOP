import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs } from '@aeon-ui/geometry'
import { sceneRoomVars, type SceneRoomCamera, type SceneRoomSize } from '@aeon-ui/scene'
import type { SurfaceMaterial } from '@aeon-ui/surface'
import { ScenePlane } from './scene-plane.js'

export type SceneRoomProps = HTMLAttributes<HTMLDivElement> & {
  size?: SceneRoomSize
  camera?: SceneRoomCamera
  floorMaterial?: SurfaceMaterial
  wallMaterial?: SurfaceMaterial
  /** Content mounted on the floor plane (counter-rotated to face the viewer). */
  floor?: ReactNode
}

const DEFAULT_SIZE: SceneRoomSize = { width: 1280, height: 680, depth: 920 }

/**
 * CSS 3D box room — floor, ceiling, back, left, and right faces with a shared vanishing point.
 * Mount UI via `floor` so it sits on the ground plane in the same transform space.
 */
export function SceneRoom({
  size = DEFAULT_SIZE,
  camera,
  floorMaterial = 'pavement',
  wallMaterial = 'brick',
  floor,
  className,
  style,
  children,
  ...rest
}: SceneRoomProps) {
  const merged: CSSProperties = {
    ...sceneRoomVars(size, camera),
    ...style,
  }

  const interactive = Boolean(floor)

  return (
    <div
      {...rest}
      {...sceneAttrs('room-wrap')}
      className={['aeon-scene-room-wrap', className].filter(Boolean).join(' ')}
      style={merged}
      aria-hidden={rest['aria-hidden'] ?? (interactive ? undefined : true)}
    >
      <div {...sceneAttrs('room')} className="aeon-scene-room">
        <ScenePlane
          part="ceiling"
          fill={false}
          className="aeon-scene-room__face aeon-scene-room__ceiling"
        />
        <ScenePlane
          part="back-wall"
          material={wallMaterial}
          fill={false}
          className="aeon-scene-room__face aeon-scene-room__back"
        />
        <ScenePlane
          part="wall-left"
          material={wallMaterial}
          fill={false}
          className="aeon-scene-room__face aeon-scene-room__left"
        />
        <ScenePlane
          part="wall-right"
          material={wallMaterial}
          fill={false}
          className="aeon-scene-room__face aeon-scene-room__right"
        />
        <div className="aeon-scene-room__face aeon-scene-room__floor">
          <ScenePlane part="ground" material={floorMaterial} fill className="aeon-scene-room__floor-plane">
            {children}
          </ScenePlane>
          {floor ? <div className="aeon-scene-room__floor-slot">{floor}</div> : null}
        </div>
      </div>
    </div>
  )
}
