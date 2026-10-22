/**
 * A group call's people: one tile each with their video or name, whether they
 * are still ringing or connecting, a muted mark, and the safety code for the
 * link to them. Each tile plays its own person's audio.
 */
import { useEffect, useRef } from 'react'
import { callPeerLabel } from '../../features/calls/useCall'
import type { CallParticipant } from '../../wallet/calls/callEngine'
import { MicOffIcon } from '../icons'
import { SafetyCode } from './SafetyCode'

function useStream<T extends HTMLMediaElement>(stream: MediaStream | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || el.srcObject === stream) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => undefined)
  }, [stream])
  return ref
}

const STATUS_TEXT: Record<CallParticipant['status'], string> = {
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  connected: '',
}

function ParticipantTile({ person }: { person: CallParticipant }) {
  const label = callPeerLabel(person.peer)
  const audioRef = useStream<HTMLAudioElement>(person.stream)
  const videoRef = useStream<HTMLVideoElement>(person.stream)
  const showVideo = person.status === 'connected' && (person.state.camera || person.state.sharing)
  return (
    <div className="call-dock-tile" data-aeon-part="participant" data-status={person.status}>
      <audio ref={audioRef} autoPlay data-aeon-part="participant-audio" />
      <video
        ref={videoRef}
        className="call-dock-tile-video"
        autoPlay
        playsInline
        muted
        data-sharing={person.state.sharing ? 'on' : undefined}
        hidden={!showVideo}
      />
      {showVideo ? null : <span className="call-dock-stage-name">{label}</span>}
      <span className="call-dock-tile-caption">
        <span className="call-dock-tile-name">{label}</span>
        {person.status === 'connected' && person.state.muted ? (
          <span className="call-dock-tile-muted" aria-label="Muted" title="Muted">
            <MicOffIcon size={14} />
          </span>
        ) : null}
        {STATUS_TEXT[person.status] ? <span className="call-dock-tile-status">{STATUS_TEXT[person.status]}</span> : null}
        <SafetyCode code={person.safety} peer={label} group />
      </span>
    </div>
  )
}

export function CallParticipants({ people }: { people: CallParticipant[] }) {
  return (
    <div className="call-dock-grid" data-aeon-part="participants" data-count={Math.min(people.length, 5)}>
      {people.map((person) => (
        <ParticipantTile key={person.peer} person={person} />
      ))}
    </div>
  )
}
