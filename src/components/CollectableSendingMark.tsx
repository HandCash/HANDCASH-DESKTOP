/**
 * Corner / media overlay while a collectable send or listing is in flight.
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
      <span className="collectable-verify-spinner" aria-hidden />
      <span className="collectable-sending-mark-label">{verb}</span>
    </span>
  )
}
