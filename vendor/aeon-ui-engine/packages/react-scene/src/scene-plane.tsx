import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs } from '@aeon-ui/geometry'
import { sceneTransformStyle, sceneWallClip, type SceneTransform3d } from '@aeon-ui/scene'
import { surfaceClass, type SurfaceMaterial } from '@aeon-ui/surface'

export type ScenePlaneProps = HTMLAttributes<HTMLDivElement> & {
  part?: string
  /** Extra transform on this plane (in addition to parent `SceneLayer`). */
  transform?: SceneTransform3d
  origin?: string
  /** Cover the parent layer (`inset: 0`). Default true. */
  fill?: boolean
  texture?: string
  material?: SurfaceMaterial
  /** Left or right wall trapezoid clip. */
  wall?: 'left' | 'right'
  children?: ReactNode
}

/** Textured or material-filled plane in 3D space — ground, wall, backdrop, UI mount. */
export function ScenePlane({
  part = 'plane',
  transform,
  origin = '50% 50%',
  fill = true,
  texture,
  material,
  wall,
  className,
  style,
  children,
  ...rest
}: ScenePlaneProps) {
  const merged: CSSProperties = {
    ...(transform ? sceneTransformStyle(transform, { origin }) : {}),
    ...(texture
      ? {
          backgroundImage: `url(${texture})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : {}),
    ...(wall ? { clipPath: sceneWallClip(wall) } : {}),
    ...style,
  }

  const classes = [
    'aeon-scene-plane',
    fill ? 'aeon-scene-plane--fill' : '',
    material ? surfaceClass(material) : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  const interactive = Boolean(children)

  return (
    <div
      {...rest}
      {...sceneAttrs(part)}
      className={classes}
      style={merged}
      aria-hidden={interactive ? undefined : true}
    >
      {children}
    </div>
  )
}
