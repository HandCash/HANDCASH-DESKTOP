/**
 * The call on screen: an incoming ring with Accept and Decline, then a bar
 * with the friend, the time on the call, mute, camera and hang up, above it
 * the video when either side's camera is on. Answer buttons never take
 * keyboard focus and ignore keyboard clicks, so a key press meant for
 * something else can't answer a call.
 */
import { useEffect, useRef, type ChangeEvent, type MouseEvent } from 'react'
import { useCall, useCallDevices, useCallElapsed } from '../../features/calls/useCall'
import { callDurationText, callOutcomeText } from '../../wallet/calls/callHistory'
import { callEngine } from '../../wallet/calls/callService'
import { readCallSettings } from '../../wallet/calls/callSettings'
import { nextCamera, type CallDevice } from '../../wallet/calls/mediaDevices'
import { CallEndIcon, CallIcon, CameraSwitchIcon, MicIcon, MicOffIcon, TuneIcon, VideocamIcon, VideocamOffIcon } from '../icons'

/** Pointer only: a click the keyboard produced (detail 0) does nothing. */
export function pointerOnly(run: () => void) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) return
    run()
  }
}

const keepFocus = (event: MouseEvent) => event.preventDefault()

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
  if (snapshot.matches('idle')) return null

  const saved = readCallSettings()
  const mic = inUse.mic ?? saved.mic
  const camera = inUse.camera ?? saved.camera
  const switchTo = c.camera ? nextCamera(devices, camera) : null
  const stage = live && (c.camera || c.remoteCamera)
  const cameraProblem = live ? engine.cameraProblem() : null

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
      data-video={stage ? 'on' : undefined}
      aria-label={`Call with ${peerLabel}`}
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
            hidden={!c.remoteCamera}
          />
          {c.remoteCamera ? null : (
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
            hidden={!c.camera}
          />
        </div>
      ) : null}
      <span className="call-dock-mark" data-aeon-part="mark" aria-hidden>
        {c.video ? <VideocamIcon size={18} /> : <CallIcon size={18} />}
      </span>
      <div className="call-dock-who" data-aeon-part="who">
        <strong className="call-dock-name">{peerLabel}</strong>
        <span className="call-dock-status" data-aeon-part="status" aria-live="polite">
          {snapshot.matches('incoming') ? (c.video ? 'Incoming video call' : 'Incoming call') : status}
          {c.remoteMuted && snapshot.matches('active') ? ' · they’re muted' : ''}
          {cameraProblem ? ` · ${cameraProblem}` : ''}
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
          <details className="call-dock-devices" data-aeon-part="devices">
            <summary className="call-dock-btn" aria-label="Microphone and camera" title="Microphone and camera">
              <TuneIcon size={20} />
            </summary>
            <div className="call-dock-devices-menu">
              <DevicePicker devices={devices} kind="audioinput" label="Microphone" value={mic} />
              <DevicePicker devices={devices} kind="videoinput" label="Camera" value={camera} />
            </div>
          </details>
          {switchTo ? (
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
