import {
  CloseIcon,
  FireIcon,
  ListingIcon,
  PayIcon,
  SendIcon,
} from './icons'

type InFlightAction = 'send' | 'burn' | 'list' | 'cancel' | 'buy'

function actionForVerb(verb: string): InFlightAction {
  if (/^burn/i.test(verb)) return 'burn'
  if (/^list/i.test(verb)) return 'list'
  if (/^cancel/i.test(verb)) return 'cancel'
  if (/^buy/i.test(verb)) return 'buy'
  return 'send'
}

function ActionIcon({ action }: { action: InFlightAction }) {
  if (action === 'burn') return <FireIcon size={14} />
  if (action === 'list') return <ListingIcon size={14} />
  if (action === 'cancel') return <CloseIcon size={14} />
  if (action === 'buy') return <PayIcon size={14} />
  return <SendIcon size={14} />
}

/**
 * Corner / media overlay while a collectable send, burn, or listing is in flight.
 * The action icon remains legible over small media; the accessible label carries
 * the full progress verb without squeezing text across the artwork.
 */
export function CollectableSendingMark({
  sending,
  verb = 'Sending',
}: {
  sending: boolean
  verb?: string
}) {
  if (!sending) return null
  const action = actionForVerb(verb)

  return (
    <span
      className="collectable-sending-mark"
      data-action={action}
      aria-live="polite"
      aria-label={verb}
      title={verb}
    >
      <ActionIcon action={action} />
    </span>
  )
}

/** Small corner badge when an item or token is listed on the market. */
export function CollectableListedMark({ label }: { label: string }) {
  return (
    <span className="collectable-listed-mark" aria-label={label} title={label}>
      {label}
    </span>
  )
}
