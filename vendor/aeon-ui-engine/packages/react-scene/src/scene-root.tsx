import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { sceneAttrs, type SceneState } from '@aeon-ui/geometry'

export type SceneRootProps = HTMLAttributes<HTMLDivElement> & {
  part?: string
  state?: SceneState
  children?: ReactNode
}

/** Root for an ambient scene region (`data-aeon-scope="scene"`). */
export function SceneRoot({
  part = 'root',
  state,
  className,
  style,
  children,
  ...rest
}: SceneRootProps) {
  return (
    <div
      {...rest}
      {...sceneAttrs(part, state)}
      className={className}
      style={style}
    >
      {children}
    </div>
  )
}

export type SceneBackdropProps = HTMLAttributes<HTMLDivElement> & {
  state?: SceneState
  style?: CSSProperties
}

/** Full-bleed backdrop slot inside a scene. */
export function SceneBackdrop({ state, className, style, children, ...rest }: SceneBackdropProps) {
  return (
    <div
      {...rest}
      {...sceneAttrs('backdrop', state)}
      className={className}
      style={{ position: 'absolute', inset: 0, ...style }}
      aria-hidden
    >
      {children}
    </div>
  )
}
