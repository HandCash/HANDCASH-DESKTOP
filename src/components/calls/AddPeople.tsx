/**
 * The host asks more friends onto the call under way: a list of friends not
 * already on it, each one tap to ring. Hidden once the call is full.
 */
import { useEffect, useRef, useState } from 'react'
import { CALL_MAX_PARTICIPANTS } from '../../wallet/calls/callWire'
import { callEngine } from '../../wallet/calls/callService'
import { listFriends, subscribeFriends, type Friend } from '../../wallet/friends'
import { PersonAddIcon } from '../icons'

export function AddPeople({ onCall }: { onCall: string[] }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  useEffect(() => subscribeFriends(setFriends), [])
  const engine = callEngine()
  if (!engine.canInvite()) return null
  const on = new Set(onCall)
  const choices = friends.filter((f) => !on.has(f.identityKey.toLowerCase()))
  const ask = (friend: Friend) => {
    engine.invite(friend.identityKey)
    if (ref.current) ref.current.open = false
  }
  return (
    <details ref={ref} className="call-dock-devices" data-aeon-part="add-people">
      <summary className="call-dock-btn" aria-label="Add people" title="Add people">
        <PersonAddIcon size={20} />
      </summary>
      <div className="call-dock-devices-menu call-dock-add-menu">
        <strong>Add to the call</strong>
        {choices.length === 0 ? (
          <p className="call-dock-share-note">Every friend is already on this call.</p>
        ) : (
          <ul className="call-dock-add-list">
            {choices.map((friend) => (
              <li key={friend.id}>
                <button type="button" className="call-dock-add-friend" data-aeon-part="add-friend" onClick={() => ask(friend)}>
                  {friend.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="call-dock-share-note">Up to {CALL_MAX_PARTICIPANTS} people, each connected straight to the others.</p>
      </div>
    </details>
  )
}
