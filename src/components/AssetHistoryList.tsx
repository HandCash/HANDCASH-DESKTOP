import { HistoryActionMarkBadge } from './RecentActivity'
import {
  openAddFriend,
  openCollectableDetails,
  openFriendDetails,
  openFungibleDetails,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import type { ItemHistoryEvent } from '../wallet/itemHistory'

function openContact(event: ItemHistoryEvent) {
  const contact = event.contact
  if (!contact) return
  playWalletSound('soft')
  if (contact.friendId) {
    openFriendDetails(contact.friendId)
    return
  }
  openAddFriend({
    identityKey: contact.identityKey,
    label: contact.label,
  })
}

function openAsset(event: ItemHistoryEvent) {
  const asset = event.asset
  if (!asset) return
  playWalletSound('soft')
  if (asset.kind === 'token') openFungibleDetails(asset.tokenId)
  else openCollectableDetails(asset.outpoint)
}

export function AssetHistoryList({ events }: { events: ItemHistoryEvent[] }) {
  if (events.length === 0) return null
  return (
    <section className="item-history" data-aeon-part="history" data-aeon-scope="item-history">
      <h4 className="field-static-label">History</h4>
      <ol className="item-history-list">
        {events.map((event) => (
          <li key={event.id} data-aeon-state={event.kind}>
            <span className="item-history-node">
              <HistoryActionMarkBadge
                mark={event.mark}
                label={event.title}
                inline
                size="timeline"
              />
            </span>
            <div className="item-history-copy">
              <strong>{event.title}</strong>
              <span>{event.detail}</span>
              {event.contact || event.asset ? (
                <div className="item-history-links">
                  {event.contact ? (
                    <button
                      type="button"
                      className="item-history-chip"
                      title="Open contact"
                      onClick={() => openContact(event)}
                    >
                      {event.contact.label}
                    </button>
                  ) : null}
                  {event.asset ? (
                    <button
                      type="button"
                      className="item-history-chip"
                      title="Open asset"
                      onClick={() => openAsset(event)}
                    >
                      {event.asset.name}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {event.at ? (
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Date(event.at).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
