import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs } from '@aeon-ui/geometry'
import { sceneTransformStyle, type SceneTransform3d } from '@aeon-ui/scene'

export type SceneSlotProps = HTMLAttributes<HTMLDivElement> & {
  part?: string
  transform?: SceneTransform3d
  origin?: string
  fill?: boolean
  children?: ReactNode
}

/** Mount arbitrary UI (boards, HUD, controls) at a 3D transform — receives pointer events. */
export function SceneSlot({
  part = 'slot',
  transform,
  origin = '50% 50%',
  fill = false,
  className,
  style,
  children,
  ...rest
}: SceneSlotProps) {
  const merged: CSSProperties = {
    ...(transform ? sceneTransformStyle(transform, { origin }) : { transformStyle: 'preserve-3d' }),
    ...style,
  }

  return (
    <div
      {...rest}
      {...sceneAttrs(part)}
      className={['aeon-scene-slot', fill ? 'aeon-scene-slot--fill' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={merged}
    >
      {children}
    </div>
  )
}
