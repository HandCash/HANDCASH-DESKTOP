import { useEffect, useState } from 'react'

/** True when the primary input supports hover (typical mouse/trackpad). */
export function usePrefersHover() {
  const [prefersHover, setPrefersHover] = useState(true)

  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    const update = () => setPrefersHover(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return prefersHover
}
