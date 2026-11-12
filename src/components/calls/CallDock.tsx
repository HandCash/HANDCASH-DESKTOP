import { useEffect, useRef } from 'react'
import { Button } from '@aeon-ui/react'
import { callEngine } from '../../wallet/calls/callService'
import { callStatus } from '../../features/calls/callPresentation'
import { useCall, useCallElapsed } from '../../features/calls/useCall'

function Media({ stream, muted, video }: { stream: MediaStream | null; muted?: boolean; video: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted={muted} hidden={!video} className="call-dock-video" />
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Presentation only: the call chart decides every step; buttons send engine intents. */
export function CallDock() {
  const view = useCall()
  const { snapshot } = view
  const { context } = snapshot
  const elapsed = useCallElapsed(context.connectedAt, context.endedAt)
  if (snapshot.matches('idle')) return null
  const engine = callEngine()
  const incoming = snapshot.matches('incoming')
  const ended = snapshot.matches('ended')
  const live = snapshot.matches('active')
  const incomingVideo = context.video
  const cameraProblem = ended ? null : engine.cameraProblem()
  return (
    <aside className="call-dock" role="region" aria-label="Call" data-aeon-scope="call-dock" data-aeon-state={view.state}>
      <Media stream={view.remote} video={context.remoteCamera || context.remoteSharing} />
      <Media stream={view.local} muted video={context.camera || context.sharing} />
      <div className="call-dock-info" data-aeon-part="info">
        <strong>{view.peerLabel}</strong>
        <span>{callStatus(snapshot)}{live ? ` · ${clock(elapsed)}` : ''}</span>
        {live && engine.encrypted() ? <span title="Media is end-to-end encrypted">Encrypted</span> : null}
        {cameraProblem ? <span role="status" data-aeon-part="problem">{cameraProblem}</span> : null}
      </div>
      <div className="call-dock-actions" data-aeon-part="actions">
        {incoming ? (
          <>
            <Button.Root className="btn" onClick={() => void engine.accept({ video: incomingVideo })}><Button.Label>Answer</Button.Label></Button.Root>
            <Button.Root className="btn btn-ghost" onClick={() => engine.decline()}><Button.Label>Decline</Button.Label></Button.Root>
          </>
        ) : ended ? (
          <Button.Root className="btn btn-ghost" onClick={() => engine.dismiss()}><Button.Label>Close</Button.Label></Button.Root>
        ) : (
          <>
            {live ? (
              <>
                <Button.Root className="btn btn-ghost" aria-pressed={context.muted} onClick={() => engine.toggleMute()}>
                  <Button.Label>{context.muted ? 'Unmute' : 'Mute'}</Button.Label>
                </Button.Root>
                <Button.Root className="btn btn-ghost" aria-pressed={context.camera} onClick={() => void engine.setCamera(!context.camera)}>
                  <Button.Label>{context.camera ? 'Camera off' : 'Camera on'}</Button.Label>
                </Button.Root>
              </>
            ) : null}
            <Button.Root className="btn" onClick={() => engine.hangUp()}><Button.Label>{live ? 'Hang up' : 'Cancel'}</Button.Label></Button.Root>
          </>
        )}
      </div>
    </aside>
  )
}
