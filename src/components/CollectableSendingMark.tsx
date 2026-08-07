/**
 * Corner / media overlay while a collectable send is in flight (including after
 * the user leaves the send screen).
 */
export function CollectableSendingMark({ sending }: { sending: boolean }) {
  if (!sending) return null

  return (
    <span
      className="collectable-sending-mark"
      aria-live="polite"
      aria-label="Sending"
      title="Sending"
    >
      <span className="collectable-verify-spinner" aria-hidden />
      <span className="collectable-sending-mark-label">Sending</span>
    </span>
  )
}
