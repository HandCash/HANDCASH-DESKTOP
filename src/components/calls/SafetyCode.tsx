/**
 * The call's safety code: a lock beside the friend's name opens twelve digits
 * both sides read to each other. The same digits mean the media is sealed to
 * this friend's identity and nothing sits between the two connections. On a
 * group call each person has their own code, for the link to them.
 */
import { LockIcon } from '../icons'

export function SafetyCode({ code, peer, group = false }: { code: string | null; peer: string; group?: boolean }) {
  if (!code) return null
  return (
    <details className="call-dock-devices call-dock-safety" data-aeon-part="safety">
      <summary className="call-dock-safety-mark" aria-label="End-to-end encrypted — show safety code" title="End-to-end encrypted">
        <LockIcon size={14} />
      </summary>
      <div className="call-dock-devices-menu call-dock-safety-menu" data-aeon-part="safety-menu">
        <strong>End-to-end encrypted</strong>
        <p className="call-dock-safety-code" data-aeon-part="safety-code">
          {code}
        </p>
        <p className="call-dock-share-note">
          {group
            ? `Read these numbers to ${peer}. If theirs match, nobody sits between the two of you.`
            : `Read these numbers to ${peer}. If theirs match, only the two of you can hear and see this call.`}
        </p>
      </div>
    </details>
  )
}
