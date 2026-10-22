/**
 * Share a screen or window in a call: the button opens a picker of whole
 * screens and single windows, with thumbnails; picking one starts sending it
 * in place of the camera. While sharing, the same spot stops the share.
 */
import { useRef, useState, type SyntheticEvent } from 'react'
import { callEngine } from '../../wallet/calls/callService'
import { listScreenSources, type ScreenSource } from '../../wallet/calls/screenCapture'
import { DeferredImage } from '../DeferredImage'
import { ScreenShareIcon, StopScreenShareIcon } from '../icons'

const GROUPS: { kind: ScreenSource['kind']; title: string }[] = [
  { kind: 'screen', title: 'Whole screen' },
  { kind: 'window', title: 'One window' },
]

export function ScreenSharePicker({ sharing }: { sharing: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const engine = callEngine()
  if (!engine.canShareScreen()) return null

  if (sharing) {
    return (
      <button
        type="button"
        className="call-dock-btn"
        data-aeon-part="stop-share"
        aria-pressed
        aria-label="Stop sharing"
        title="Stop sharing"
        onClick={() => void engine.stopSharing()}
      >
        <StopScreenShareIcon size={20} />
      </button>
    )
  }

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return
    setSources(null)
    void listScreenSources().then(setSources, () => setSources([]))
  }

  const pick = (id: string) => {
    if (ref.current) ref.current.open = false
    void engine.shareScreen(id)
  }

  return (
    <details ref={ref} className="call-dock-devices" data-aeon-part="share" onToggle={onToggle}>
      <summary className="call-dock-btn" aria-label="Share screen" title="Share screen">
        <ScreenShareIcon size={20} />
      </summary>
      <div className="call-dock-devices-menu call-dock-share-menu" data-aeon-part="share-menu">
        {sources === null ? (
          <p className="call-dock-share-note">Finding screens and windows…</p>
        ) : sources.length === 0 ? (
          <p className="call-dock-share-note">Nothing to share — HandCash may need permission to record the screen</p>
        ) : (
          GROUPS.map(({ kind, title }) => {
            const list = sources.filter((s) => s.kind === kind)
            if (list.length === 0) return null
            return (
              <section key={kind} className="call-dock-share-group" data-aeon-part={`share-${kind}s`}>
                <h3>{title}</h3>
                <div className="call-dock-share-grid">
                  {list.map((s) => (
                    <button key={s.id} type="button" className="call-dock-share-source" title={s.name} onClick={() => pick(s.id)}>
                      <span className="call-dock-share-thumb" aria-hidden>
                        {s.thumbnail ? <DeferredImage src={s.thumbnail} alt="" retainDecoded /> : null}
                      </span>
                      <span>{s.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )
          })
        )}
      </div>
    </details>
  )
}
