export const surfaceMaterials = ['stone', 'gravel', 'brick', 'pavement', 'kraft'] as const
export type SurfaceMaterial = (typeof surfaceMaterials)[number]

const PREFIX = 'aeon-surface'

/** BEM class for a material layer (`aeon-surface aeon-surface--stone`). */
export function surfaceClass(material: SurfaceMaterial): string {
  return `${PREFIX} ${PREFIX}--${material}`
}

/** Optional inline vars to tune a surface on a custom element. */
export function surfaceStyleVars(material: SurfaceMaterial): Record<string, string> {
  return { '--aeon-surface-material': material }
}
