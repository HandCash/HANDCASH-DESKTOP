import { useEffect, useRef, useState } from 'react'
import {
  attachMediaAnalyser,
  bandRanges,
  createBarMotionState,
  resumeAudioContext,
  stepBarMotion,
  type BarMotionOptions,
} from '@aeon-ui/signal'

export type UseSignalVisualizerOptions = BarMotionOptions & {
  enabled?: boolean
  barCount?: number
  /** When set, attaches analyser to this element while active. */
  media?: HTMLAudioElement | null
  /** Use a pre-attached analyser (e.g. from `createDemoSignal`). */
  analyser?: AnalyserNode | null
  active?: boolean
}

/**
 * RAF loop: frequency bands → per-bar scale + brightness (Soundbase-style motion).
 */
export function useSignalVisualizer(options: UseSignalVisualizerOptions = {}) {
  const {
    enabled = true,
    barCount = 7,
    media = null,
    analyser: analyserProp = null,
    active: activeProp,
    ...motionOptions
  } = options

  const active = activeProp ?? (enabled && (!!analyserProp || !!media))
  const [scales, setScales] = useState(() => createBarMotionState(barCount, motionOptions).scales)
  const [brightness, setBrightness] = useState(
    () => createBarMotionState(barCount, motionOptions).brightness,
  )
  const motionRef = useRef(createBarMotionState(barCount, motionOptions))
  const rafRef = useRef<number | null>(null)
  const dataRef = useRef<Uint8Array | null>(null)
  const rangesRef = useRef<{ start: number; end: number }[]>([])

  useEffect(() => {
    motionRef.current = createBarMotionState(barCount, motionOptions)
  }, [barCount])

  useEffect(() => {
    if (!active) {
      motionRef.current = createBarMotionState(barCount, motionOptions)
      setScales([...motionRef.current.scales])
      setBrightness([...motionRef.current.brightness])
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    void resumeAudioContext()

    let analyser = analyserProp
    if (!analyser && media) {
      analyser = attachMediaAnalyser(media, { crossOrigin: 'anonymous' })
    }

    const bufferLength = analyser?.frequencyBinCount ?? 0
    if (analyser && bufferLength > 0) {
      dataRef.current = new Uint8Array(bufferLength)
      rangesRef.current = bandRanges(bufferLength, barCount)
    } else {
      dataRef.current = null
      rangesRef.current = []
    }

    const tick = () => {
      if (analyser && dataRef.current) {
        analyser.getByteFrequencyData(dataRef.current as Uint8Array<ArrayBuffer>)
      }
      stepBarMotion(
        motionRef.current,
        analyser,
        dataRef.current,
        rangesRef.current,
        motionOptions,
      )
      setScales([...motionRef.current.scales])
      setBrightness([...motionRef.current.brightness])
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, media, analyserProp, barCount])

  return { scales, brightness, active }
}
