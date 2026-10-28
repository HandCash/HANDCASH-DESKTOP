/**
 * A call's recordings on its Activity row: each opens in place, unsealed in
 * memory for playback (`recordingPlayerMachine`), and can be deleted from this
 * device. A recording made on another device, or deleted, says so.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { recordingPlayerMachine } from '../../machines/recordingPlayerMachine'
import { deleteCallRecording, openCallRecording, recordingStoreAvailable } from '../../wallet/calls/recordingStore'

const PORTS = { open: openCallRecording, remove: deleteCallRecording }

function RecordingPlayer({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [player, send] = useMachine(recordingPlayerMachine, { input: { id, ports: PORTS } })
  const opened = player.context.opened
  const url = useMemo(() => (opened ? URL.createObjectURL(opened.blob) : null), [opened])
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url])
  const deleted = player.matches('deleted')
  useEffect(() => {
    if (deleted) onDeleted()
  }, [deleted, onDeleted])

  return (
    <div className="call-recording-player" data-aeon-scope="recording-player" data-aeon-state={stateToAttr(player.value)}>
      {player.matches('opening') ? <p className="call-recording-note">Opening the recording…</p> : null}
      {player.matches('gone') ? <p className="call-recording-note">This recording isn’t on this device.</p> : null}
      {player.matches('failed') ? <p className="call-recording-note">This recording couldn’t be opened or deleted.</p> : null}
      {url && opened ? (
        <>
          {(opened.meta?.video ?? true) ? (
            <video className="call-recording-media" src={url} controls playsInline />
          ) : (
            <audio className="call-recording-media" src={url} controls />
          )}
          {opened.complete ? null : <p className="call-recording-note">Part of this recording couldn’t be read; what was kept plays here.</p>}
          <button
            type="button"
            className="call-recording-action"
            data-aeon-part="delete-recording"
            disabled={!player.matches('ready')}
            onClick={() => send({ type: 'DELETE' })}
          >
            Delete recording
          </button>
        </>
      ) : null}
    </div>
  )
}

export function CallRecordings({ ids }: { ids: string[] }) {
  const [shown, setShown] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<string[]>([])
  if (!recordingStoreAvailable()) return null
  const kept = ids.filter((id) => !deleted.includes(id))
  if (kept.length === 0) return null
  return (
    <div className="call-recordings" data-aeon-part="recordings">
      {kept.map((id, i) => (
        <div key={id} className="call-recording">
          <button
            type="button"
            className="call-recording-action"
            data-aeon-part="play-recording"
            aria-expanded={shown === id}
            onClick={() => setShown(shown === id ? null : id)}
          >
            {shown === id ? 'Close recording' : kept.length > 1 ? `Play recording ${i + 1}` : 'Play recording'}
          </button>
          {shown === id ? (
            <RecordingPlayer
              id={id}
              onDeleted={() => {
                setDeleted((d) => [...d, id])
                setShown(null)
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
