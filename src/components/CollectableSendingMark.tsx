import { LoadingSpinner } from './LoadingSpinner'

/**
 * Corner / media overlay while a collectable send, burn, or listing is in flight.
 * Spinner always uses the shared accent ring — verb text carries the action name.
 */
export function CollectableSendingMark({
  sending,
  verb = 'Sending',
}: {
  sending: boolean
  verb?: string
}) {
  if (!sending) return null

  return (
    <span
      className="collectable-sending-mark"
      aria-live="polite"
      aria-label={verb}
      title={verb}
    >
      <LoadingSpinner size="sm" />
      <span className="collectable-sending-mark-label">{verb}</span>
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
