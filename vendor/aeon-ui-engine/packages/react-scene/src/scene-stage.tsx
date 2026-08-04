import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs } from '@aeon-ui/geometry'
import { sceneStageStyle, type ScenePerspective } from '@aeon-ui/scene'

export type SceneStageProps = HTMLAttributes<HTMLDivElement> & {
  perspective?: ScenePerspective
  minHeight?: SceneUnit
  children?: ReactNode
}

type SceneUnit = number | string

export function SceneStage({
  perspective,
  minHeight = 320,
  className,
  style,
  children,
  ...rest
}: SceneStageProps) {
  const merged: CSSProperties = {
    ...sceneStageStyle(perspective),
    minHeight: typeof minHeight === 'number' ? `${minHeight}px` : minHeight,
    ...style,
  }

  return (
    <div
      {...rest}
      {...sceneAttrs('stage')}
      className={['aeon-scene-stage', className].filter(Boolean).join(' ')}
      style={merged}
    >
      {children}
    </div>
  )
}
