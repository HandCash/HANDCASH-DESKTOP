import { useMemo, useSyncExternalStore } from 'react'
import { copyText } from '../wallet/clipboard'
import { listFriends, subscribeFriends } from '../wallet/friends'
import type { HandleIptView } from '../wallet/handleIpt'
import { buildIdentityCards } from '../wallet/identityCards'

type Props = { identityKey: string; ownHandle: HandleIptView }

let friendsSnapshot = listFriends()
function subscribe(cb: () => void) {
  return subscribeFriends((f) => {
    friendsSnapshot = f
    cb()
  })
}
const snapshot = () => friendsSnapshot

/** Scrollable deck of credit-card-shaped identity cards. */
export function IdentityCards({ identityKey, ownHandle }: Props) {
  const friends = useSyncExternalStore(subscribe, snapshot)
  const cards = useMemo(
    () => buildIdentityCards(identityKey, ownHandle, friends),
    [identityKey, ownHandle, friends],
  )
  return (
    <div className="id-deck" data-aeon-scope="identity-cards" aria-label="Identity cards">
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          className="id-card"
          data-aeon-part="card"
          data-aeon-state={c.kind}
          data-own={c.own ? 'true' : 'false'}
          title={`Copy identity key\n${c.identityKey}`}
          onClick={() => void copyText(c.identityKey, { label: 'wallet key' })}
        >
          <span className="id-card-top">
            <span className="id-card-title">{c.title}</span>
            <span className="id-card-kind">{c.kind === 'key' ? 'KEY' : 'BRC-169'}</span>
          </span>
          <span className="id-card-chip" aria-hidden="true" />
          <span className="id-card-number mono">
            {c.groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </span>
          <span className="id-card-bottom">
            <span className="id-card-holder">{c.holder}</span>
            <span className="id-card-mark" aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
  )
}
