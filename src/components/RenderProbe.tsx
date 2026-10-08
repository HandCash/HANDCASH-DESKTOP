import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { recordRender } from '../wallet/renderLog'

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  recordRender(id, phase, actualDuration, baseDuration)
}

/** Names a surface in `[render]` log lines. Production builds use `react-dom/profiling`. */
export function RenderProbe({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}
