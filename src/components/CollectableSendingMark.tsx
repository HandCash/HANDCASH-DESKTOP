/** Map in-flight verb to overlay tone (send = accent, burn = warm amber, market = accent-alt). */
export function sendingMarkTone(verb: string): 'burn' | 'listing' | 'default' {
  if (/^burn/i.test(verb)) return 'burn'
  if (/^(list|cancel|buy)/i.test(verb)) return 'listing'
  return 'default'
}

/**
 * Corner / media overlay while a collectable send, burn, or listing is in flight.
 */
export function CollectableSendingMark({
  sending,
  verb = 'Sending',
}: {
  sending: boolean
  verb?: string
}) {
  if (!sending) return null

  const tone = sendingMarkTone(verb)

  return (
    <span
      className={`collectable-sending-mark${tone === 'burn' ? ' is-burn' : tone === 'listing' ? ' is-listing' : ''}`}
      aria-live="polite"
      aria-label={verb}
      title={verb}
    >
      <span className="collectable-verify-spinner" aria-hidden />
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
