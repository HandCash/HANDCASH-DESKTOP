/**
 * The call on screen: an incoming ring with Accept and Decline, then a bar
 * with the friend, the time on the call, mute and hang up. Accept and Decline
 * never take keyboard focus and ignore keyboard clicks, so a key press meant
 * for something else can't answer a call.
 */
import { useEffect, useRef, type MouseEvent } from 'react'
import { useCall, useCallElapsed } from '../../features/calls/useCall'
import { callDurationText, callOutcomeText } from '../../wallet/calls/callHistory'
import { callEngine } from '../../wallet/calls/callService'
import { CallEndIcon, CallIcon, MicIcon, MicOffIcon } from '../icons'

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

export function CallDock() {
  const { snapshot, state, peerLabel, remote } = useCall()
  const c = snapshot.context
  const elapsed = useCallElapsed(c.connectedAt, c.endedAt)
  const audioRef = useStreamOn<HTMLAudioElement>(remote)
  if (snapshot.matches('idle')) return null
  const engine = callEngine()

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
    <section className="call-dock" data-aeon-scope="call" data-aeon-state={state} aria-label={`Call with ${peerLabel}`}>
      <audio ref={audioRef} autoPlay data-aeon-part="remote-audio" />
      <span className="call-dock-mark" data-aeon-part="mark" aria-hidden>
        <CallIcon size={18} />
      </span>
      <div className="call-dock-who" data-aeon-part="who">
        <strong className="call-dock-name">{peerLabel}</strong>
        <span className="call-dock-status" data-aeon-part="status" aria-live="polite">
          {snapshot.matches('incoming') ? 'Incoming call' : status}
          {c.remoteMuted && snapshot.matches('active') ? ' · they’re muted' : ''}
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
          <button
            type="button"
            className="call-dock-btn"
            data-aeon-part="accept"
            tabIndex={-1}
            aria-label="Accept"
            title="Accept"
            onMouseDown={keepFocus}
            onClick={pointerOnly(() => void engine.accept())}
          >
            <CallIcon size={20} />
          </button>
        </div>
      ) : snapshot.matches('ended') ? null : (
        <div className="call-dock-actions" data-aeon-part="controls">
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
