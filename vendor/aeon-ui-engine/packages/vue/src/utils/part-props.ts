import type { HTMLAttributes } from 'vue'

export function partProps(
  attrs: Record<string, unknown>,
  extra?: HTMLAttributes,
): HTMLAttributes {
  return { ...attrs, ...extra } as HTMLAttributes
}
