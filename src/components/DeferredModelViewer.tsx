import { createElement, useEffect, useRef } from 'react'
import { useMachine } from '@xstate/react'
import type { ModelViewerElement } from '@google/model-viewer'
import { modelViewerMachine } from '../machines/modelViewerMachine'
import { Skeleton } from './Skeleton'

type Props = {
  src: string
  alt: string
}

const MODEL_LOAD_TIMEOUT_MS = 30_000

/**
 * Interactive GLB / GLTF viewer that follows the app-wide deferred-media rule.
 *
 * The custom element stays mounted under the skeleton so importing the renderer,
 * fetching the body and decoding textures can proceed. It is revealed only
 * after the load event has had two animation frames to paint its first frame.
 */
export function DeferredModelViewer({ src, alt }: Props) {
  const [snapshot, send] = useMachine(modelViewerMachine)
  const modelRef = useRef<ModelViewerElement | null>(null)
  const attempt = snapshot.context.attempt

  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    let cancelled = false
    let firstFrame = 0
    let timeout = 0

    const fail = (message: string) => {
      if (!cancelled) send({ type: 'FAIL', error: message })
    }
    const onLoad = () => {
      window.clearTimeout(timeout)
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = window.requestAnimationFrame(() => {
          if (!cancelled) send({ type: 'READY' })
        })
      })
    }
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail
      fail(detail?.type ? `Couldn’t render this model (${detail.type})` : 'Couldn’t render this model')
    }

    model.addEventListener('load', onLoad)
    model.addEventListener('error', onError)

    void import('@google/model-viewer').catch((error) => {
      fail(error instanceof Error ? error.message : '3D renderer unavailable')
    })

    timeout = window.setTimeout(
      () => fail('The 3D model took too long to load'),
      MODEL_LOAD_TIMEOUT_MS,
    )
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      if (firstFrame) window.cancelAnimationFrame(firstFrame)
      model.removeEventListener('load', onLoad)
      model.removeEventListener('error', onError)
    }
  }, [attempt, send, src])

  const state = snapshot.matches('ready')
    ? 'ready'
    : snapshot.matches('failed')
      ? 'failed'
      : 'loading'

  return (
    <div className="collectable-model-viewer" data-aeon-scope="model-viewer" data-aeon-state={state}>
      {snapshot.matches('loading') ? (
        <Skeleton
          className="collectable-model-skeleton"
          width="100%"
          height="100%"
          radius={14}
        />
      ) : null}
      {snapshot.matches('failed') ? (
        <div className="collectable-model-fallback" role="alert">
          <strong>3D preview unavailable</strong>
          <span>{snapshot.context.error}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => send({ type: 'RETRY' })}
          >
            Try again
          </button>
        </div>
      ) : null}
      {createElement('model-viewer', {
        key: `${src}:${attempt}`,
        ref: modelRef,
        class: 'collectable-model-element',
        src,
        alt,
        loading: 'eager',
        reveal: 'auto',
        'camera-controls': '',
        'auto-rotate': '',
        'auto-rotate-delay': '900',
        'rotation-per-second': '18deg',
        'interaction-prompt': 'auto',
        'interaction-prompt-threshold': '1600',
        'environment-image': 'neutral',
        exposure: '1.05',
        'shadow-intensity': '1.1',
        'shadow-softness': '0.8',
        'tone-mapping': 'aces',
        autoplay: '',
        'interpolation-decay': '160',
        'camera-orbit': '35deg 68deg auto',
        'min-camera-orbit': 'auto auto 35%',
        'max-camera-orbit': 'auto auto 250%',
        tabIndex: snapshot.matches('ready') ? 0 : -1,
        'aria-hidden': snapshot.matches('ready') ? undefined : 'true',
      })}
      {snapshot.matches('ready') ? (
        <span className="collectable-model-hint">Drag to rotate · scroll to zoom</span>
      ) : null}
    </div>
  )
}
