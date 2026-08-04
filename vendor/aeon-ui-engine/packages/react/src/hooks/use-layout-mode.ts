import type { LayoutCompositionSpec, LayoutMode, ResponsiveLayoutSpec } from '@aeon-ui/core'
import { getCompactMq, layoutCompositionForMode, matchLayoutMode } from '@aeon-ui/core'
import { useEffect, useMemo, useState } from 'react'

export function useLayoutMode(spec: ResponsiveLayoutSpec): {
  mode: LayoutMode
  composition: LayoutCompositionSpec
} {
  const mq = useMemo(() => getCompactMq(spec), [spec.compactMq])
  const [mode, setMode] = useState<LayoutMode>(() => matchLayoutMode(spec, mq))

  useEffect(() => {
    const sync = () => setMode(matchLayoutMode(spec, mq))
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [spec, mq])

  const composition = useMemo(() => layoutCompositionForMode(spec, mode), [spec, mode])

  return { mode, composition }
}
