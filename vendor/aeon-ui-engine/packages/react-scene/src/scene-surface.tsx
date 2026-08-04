import type { HTMLAttributes } from 'react'
import { surfaceClass, type SurfaceMaterial } from '@aeon-ui/surface'
import { sceneAttrs } from '@aeon-ui/geometry'

export type SceneSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  material: SurfaceMaterial
}

/** Textured material layer (`@aeon-ui/surface` CSS + scene anatomy). */
export function SceneSurface({ material, className, children, ...rest }: SceneSurfaceProps) {
  return (
    <div
      {...rest}
      {...sceneAttrs('surface')}
      className={[surfaceClass(material), className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  )
}
