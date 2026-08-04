import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs } from '@aeon-ui/geometry'
import { sceneTransformStyle, type SceneTransform3d } from '@aeon-ui/scene'

export type SceneLayerProps = HTMLAttributes<HTMLDivElement> & {
  part?: string
  transform?: SceneTransform3d
  origin?: string
  children?: ReactNode
}

/** Positioned 3D layer inside a `SceneStage` (absolute fill + transform). */
export function SceneLayer({
  part = 'layer',
  transform,
  origin = '50% 50%',
  className,
  style,
  children,
  ...rest
}: SceneLayerProps) {
  const merged: CSSProperties = {
    ...(transform ? sceneTransformStyle(transform, { origin }) : { transformStyle: 'preserve-3d' }),
    ...style,
  }

  return (
    <div
      {...rest}
      {...sceneAttrs(part)}
      className={['aeon-scene-layer', className].filter(Boolean).join(' ')}
      style={merged}
      aria-hidden={rest['aria-hidden'] ?? true}
    >
      {children}
    </div>
  )
}
