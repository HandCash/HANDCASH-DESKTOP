/**
 * The call on screen: an incoming ring with Accept and Decline, then a bar
 * with the friend, the time on the call, mute, camera and hang up, above it
 * the video when either side's camera is on. Moving around the wallet shrinks
 * a live call to a tile in a corner (`callViewMachine`), dragged to any corner
 * and expanded with a click; the far side's video can also pop out to the
 * system picture-in-picture window. Answer buttons never take
 * keyboard focus and ignore keyboard clicks, so a key press meant for
 * something else can't answer a call.
 */
import { useEffect, useRef, type ChangeEvent, type MouseEvent, type PointerEvent } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { callViewMachine, nearestCorner } from '../../machines/callViewMachine'
import { useCall, useCallDevices, useCallElapsed } from '../../features/calls/useCall'
import { callDurationText, callOutcomeText } from '../../wallet/calls/callHistory'
import { callEngine } from '../../wallet/calls/callService'
import { readCallSettings } from '../../wallet/calls/callSettings'
import { nextCamera, type CallDevice } from '../../wallet/calls/mediaDevices'
import { getNavState, subscribeNav } from '../../wallet/navStore'
import { SafetyCode } from './SafetyCode'
import { ScreenSharePicker } from './ScreenSharePicker'
import {
  CallEndIcon,
  CallIcon,
  CameraSwitchIcon,
  CloseFullscreenIcon,
  MicIcon,
  MicOffIcon,
  OpenInFullIcon,
  PictureInPictureIcon,
  TuneIcon,
  VideocamIcon,
  VideocamOffIcon,
} from '../icons'

/** Pointer only: a click the keyboard produced (detail 0) does nothing. */
export function pointerOnly(run: () => void) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) return
    run()
  }
}

const keepFocus = (event: MouseEvent) => event.preventDefault()

/** Movement, in pixels, before a press on the tile counts as a drag rather than a click. */
const DRAG_SLOP = 4

const SYSTEM_PIP_ACTIONS = ['togglemicrophone', 'togglecamera', 'hangup'] as const

type CallMediaSession = MediaSession & {
  setMicrophoneActive?: (active: boolean) => void
  setCameraActive?: (active: boolean) => void
}

function setSystemPipAction(action: (typeof SYSTEM_PIP_ACTIONS)[number], run: (() => void) | null): void {
  try {
    globalThis.navigator?.mediaSession?.setActionHandler(action as MediaSessionAction, run)
  } catch {
    /* this Chromium does not offer the action */
  }
}

function useStreamOn<T extends HTMLMediaElement>(stream: MediaStream | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || el.srcObject === stream) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => undefined)
  }, [stream])
  return ref
}

function DevicePicker({ devices, kind, label, value }: { devices: CallDevice[]; kind: 'audioinput' | 'videoinput'; label: string; value: string | null }) {
  const options = devices.filter((d) => d.kind === kind)
  if (options.length === 0) return null
  const engine = callEngine()
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value
    void (kind === 'audioinput' ? engine.useMic(id) : engine.useCamera(id))
  }
  return (
    <label className="call-dock-device" data-aeon-part={kind === 'audioinput' ? 'mic-picker' : 'camera-picker'}>
      <span>{label}</span>
      <select value={value && options.some((d) => d.id === value) ? value : ''} onChange={onChange}>
        {value && options.some((d) => d.id === value) ? null : <option value="">System default</option>}
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function CallDock() {
  const { snapshot, state, peerLabel, local, remote } = useCall()
  const c = snapshot.context
  const elapsed = useCallElapsed(c.connectedAt, c.endedAt)
  const audioRef = useStreamOn<HTMLAudioElement>(remote)
  const remoteVideoRef = useStreamOn<HTMLVideoElement>(remote)
  const selfRef = useStreamOn<HTMLVideoElement>(local)
  const live = !snapshot.matches('idle') && !snapshot.matches('ended') && !snapshot.matches('incoming')
  const engine = callEngine()
  const inUse = engine.devicesInUse()
  const devices = useCallDevices(live, `${inUse.mic}|${inUse.camera}`)
  const [view, sendView] = useMachine(callViewMachine)
  const over = snapshot.matches('idle') || snapshot.matches('ended')
  const pip = live && view.matches('pip')
  const popped = view.matches('popped')
  const drag = useRef<{ x: number; y: number; pointer: number; moved: boolean } | null>(null)
  const remoteShown = live && (c.remoteCamera || c.remoteSharing)

  useEffect(() => {
    if (!live) return
    const at = getNavState()
    return subscribeNav((nav) => {
      if (nav !== at) sendView({ type: 'NAVIGATED' })
    })
  }, [live, sendView])

  useEffect(() => {
    if (!over) return
    sendView({ type: 'RESET' })
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined)
  }, [over, sendView])

  useEffect(() => {
    const el = remoteVideoRef.current
    if (!el || !remoteShown) return
    const entered = () => sendView({ type: 'ENTERED_SYSTEM_PIP' })
    const left = () => sendView({ type: 'LEFT_SYSTEM_PIP' })
    el.addEventListener('enterpictureinpicture', entered)
    el.addEventListener('leavepictureinpicture', left)
    return () => {
      el.removeEventListener('enterpictureinpicture', entered)
      el.removeEventListener('leavepictureinpicture', left)
    }
  }, [remoteVideoRef, remoteShown, sendView])

  useEffect(() => {
    if (!popped) return
    setSystemPipAction('togglemicrophone', () => engine.toggleMute())
    setSystemPipAction('togglecamera', () => void engine.setCamera(!engine.getSnapshot().context.camera))
    setSystemPipAction('hangup', () => engine.hangUp())
    return () => {
      for (const action of SYSTEM_PIP_ACTIONS) setSystemPipAction(action, null)
    }
  }, [popped, engine])

  useEffect(() => {
    if (!popped) return
    const session = globalThis.navigator?.mediaSession as CallMediaSession | undefined
    session?.setMicrophoneActive?.(!c.muted)
    session?.setCameraActive?.(c.camera)
  }, [popped, c.muted, c.camera])

  if (snapshot.matches('idle')) return null

  const popOut = () => {
    const el = remoteVideoRef.current
    if (el && document.pictureInPictureEnabled) void el.requestPictureInPicture().catch(() => undefined)
  }

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!pip || event.button !== 0 || (event.target as Element).closest('button, summary, select, details, a')) return
    drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    d.moved = true
    event.currentTarget.style.translate = `${dx}px ${dy}px`
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) return
    drag.current = null
    const tile = event.currentTarget
    if (!d.moved) {
      sendView({ type: 'EXPAND' })
      return
    }
    const r = tile.getBoundingClientRect()
    tile.style.translate = ''
    sendView({ type: 'MOVE', corner: nearestCorner(r.left + r.width / 2, r.top + r.height / 2, window.innerWidth, window.innerHeight) })
  }
  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    drag.current = null
    event.currentTarget.style.translate = ''
  }

  const saved = readCallSettings()
  const mic = inUse.mic ?? saved.mic
  const camera = inUse.camera ?? saved.camera
  const switchTo = c.camera ? nextCamera(devices, camera) : null
  const remoteVideo = c.remoteCamera || c.remoteSharing
  const stage = live && (c.camera || c.sharing || remoteVideo)
  const mediaProblem = live ? (engine.e2eProblem() ?? engine.shareProblem() ?? engine.cameraProblem()) : null

  const status = snapshot.matches({ outgoing: 'reaching' })
    ? 'Calling…'
    : snapshot.matches({ outgoing: 'ringing' })
      ? 'Ringing…'
      : snapshot.matches('connecting')
        ? 'Connecting…'
        : snapshot.matches('active')
          ? callDurationText(elapsed)
          : snapshot.matches('ended') && c.outcome
            ? (c.failure ?? callOutcomeText({ ...c, outcome: c.outcome, endedAt: c.endedAt ?? Date.now() }))
            : ''

  return (
    <section
      className="call-dock"
      data-aeon-scope="call"
      data-aeon-state={state}
      data-video={stage && !popped ? 'on' : undefined}
      data-view={live ? stateToAttr(view.value) : undefined}
      data-corner={pip ? view.context.corner : undefined}
      aria-label={`Call with ${peerLabel}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <audio ref={audioRef} autoPlay data-aeon-part="remote-audio" />
      {stage ? (
        <div className="call-dock-stage" data-aeon-part="stage">
          <video
            ref={remoteVideoRef}
            className="call-dock-remote"
            data-aeon-part="remote-video"
            autoPlay
            playsInline
            muted
            data-sharing={c.remoteSharing ? 'on' : undefined}
            hidden={!remoteVideo}
          />
          {remoteVideo ? null : (
            <span className="call-dock-stage-name" data-aeon-part="remote-off">
              {peerLabel}
            </span>
          )}
          <video
            ref={selfRef}
            className="call-dock-self"
            data-aeon-part="self-video"
            autoPlay
            playsInline
            muted
            data-sharing={c.sharing ? 'on' : undefined}
            hidden={!c.camera && !c.sharing}
          />
          {pip ? null : (
            <div className="call-dock-stage-tools" data-aeon-part="stage-tools">
              {remoteVideo && document.pictureInPictureEnabled ? (
                <button
                  type="button"
                  className="call-dock-btn"
                  data-aeon-part="pop-out"
                  aria-label="Pop out"
                  title="Pop out over other apps"
                  onClick={popOut}
                >
                  <PictureInPictureIcon size={18} />
                </button>
              ) : null}
              <button
                type="button"
                className="call-dock-btn"
                data-aeon-part="shrink"
                aria-label="Shrink to a corner"
                title="Shrink to a corner"
                onClick={() => sendView({ type: 'SHRINK' })}
              >
                <CloseFullscreenIcon size={18} />
              </button>
            </div>
          )}
        </div>
      ) : null}
      <span className="call-dock-mark" data-aeon-part="mark" aria-hidden>
        {c.video ? <VideocamIcon size={18} /> : <CallIcon size={18} />}
      </span>
      <div className="call-dock-who" data-aeon-part="who">
        <span className="call-dock-name-row">
          <strong className="call-dock-name">{peerLabel}</strong>
          <SafetyCode code={live ? engine.safetyCode() : null} peer={peerLabel} />
        </span>
        <span className="call-dock-status" data-aeon-part="status" aria-live="polite">
          {snapshot.matches('incoming') ? (c.video ? 'Incoming video call' : 'Incoming call') : status}
          {c.remoteMuted && snapshot.matches('active') ? ' · they’re muted' : ''}
          {c.sharing && snapshot.matches('active') ? ' · you’re sharing your screen' : ''}
          {c.remoteSharing && snapshot.matches('active') ? ' · they’re sharing their screen' : ''}
          {mediaProblem ? ` · ${mediaProblem}` : ''}
        </span>
      </div>
      {snapshot.matches('incoming') ? (
        <div className="call-dock-actions" data-aeon-part="answer">
          <button
            type="button"
            className="call-dock-btn"
            data-aeon-part="decline"
            tabIndex={-1}
            aria-label="Decline"
            title="Decline"
            onMouseDown={keepFocus}
            onClick={pointerOnly(() => engine.decline())}
          >
            <CallEndIcon size={20} />
          </button>
          {c.video ? (
            <button
              type="button"
              className="call-dock-btn"
              data-aeon-part="accept-voice"
              tabIndex={-1}
              aria-label="Answer without video"
              title="Answer without video"
              onMouseDown={keepFocus}
              onClick={pointerOnly(() => void engine.accept({ video: false }))}
            >
              <VideocamOffIcon size={20} />
            </button>
          ) : null}
          <button
            type="button"
            className="call-dock-btn"
            data-aeon-part="accept"
            tabIndex={-1}
            aria-label={c.video ? 'Answer with video' : 'Accept'}
            title={c.video ? 'Answer with video' : 'Accept'}
            onMouseDown={keepFocus}
            onClick={pointerOnly(() => void engine.accept())}
          >
            {c.video ? <VideocamIcon size={20} /> : <CallIcon size={20} />}
          </button>
        </div>
      ) : snapshot.matches('ended') ? null : (
        <div className="call-dock-actions" data-aeon-part="controls">
          {pip ? (
            <button
              type="button"
              className="call-dock-btn"
              data-aeon-part="expand"
              aria-label="Expand the call"
              title="Expand the call"
              onClick={() => sendView({ type: 'EXPAND' })}
            >
              <OpenInFullIcon size={18} />
            </button>
          ) : null}
          {pip ? null : (
            <>
              <details className="call-dock-devices" data-aeon-part="devices">
                <summary className="call-dock-btn" aria-label="Microphone and camera" title="Microphone and camera">
                  <TuneIcon size={20} />
                </summary>
                <div className="call-dock-devices-menu">
                  <DevicePicker devices={devices} kind="audioinput" label="Microphone" value={mic} />
                  <DevicePicker devices={devices} kind="videoinput" label="Camera" value={camera} />
                </div>
              </details>
              <ScreenSharePicker sharing={c.sharing} />
              {switchTo && !c.sharing ? (
                <button
                  type="button"
                  className="call-dock-btn"
                  data-aeon-part="switch-camera"
                  aria-label="Switch camera"
                  title="Switch camera"
                  onClick={() => void engine.useCamera(switchTo)}
                >
                  <CameraSwitchIcon size={20} />
                </button>
              ) : null}
              <button
                type="button"
                className="call-dock-btn"
                data-aeon-part="camera"
                aria-pressed={c.camera}
                aria-label="Camera"
                title={c.camera ? 'Turn camera off' : 'Turn camera on'}
                onClick={() => void engine.setCamera(!c.camera)}
              >
                {c.camera ? <VideocamIcon size={20} /> : <VideocamOffIcon size={20} />}
              </button>
            </>
          )}
          <button
            type="button"
            className="call-dock-btn"
            data-aeon-part="mute"
            aria-pressed={c.muted}
            aria-label={c.muted ? 'Unmute' : 'Mute'}
            title={c.muted ? 'Unmute' : 'Mute'}
            onClick={() => engine.toggleMute()}
          >
            {c.muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
          </button>
          <button
            type="button"
            className="call-dock-btn"
            data-aeon-part="hang-up"
            aria-label="Hang up"
            title="Hang up"
            onClick={() => engine.hangUp()}
          >
            <CallEndIcon size={20} />
          </button>
        </div>
      )}
    </section>
  )
}
