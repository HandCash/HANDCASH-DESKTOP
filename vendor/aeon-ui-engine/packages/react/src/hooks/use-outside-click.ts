import { useEffect, type RefObject } from 'react'

/** Close floating content when pointer down occurs outside the container. */
export function useOutsideClick(
  refs: RefObject<HTMLElement | null>[],
  enabled: boolean,
  onOutside: () => void,
) {
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (refs.some((r) => r.current?.contains(target))) return
      onOutside()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [refs, enabled, onOutside])
}
