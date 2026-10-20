import { HistoryActionMarkBadge } from './RecentActivity'
import {
  openAddFriend,
  openCollectableDetails,
  openFriendDetails,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import type { HistoryAssetLink, ItemHistoryEvent } from '../wallet/itemHistory'

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

function openAsset(outpoint: string) {
  playWalletSound('soft')
  openCollectableDetails(outpoint)
}

function AssetChip({ asset }: { asset: HistoryAssetLink }) {
  if (asset.kind === 'token') return <span className="item-history-chip">{asset.name}</span>
  return (
    <button
      type="button"
      className="item-history-chip"
      title="Open asset"
      onClick={() => openAsset(asset.outpoint)}
    >
      {asset.name}
    </button>
  )
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
                  {event.asset ? <AssetChip asset={event.asset} /> : null}
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
