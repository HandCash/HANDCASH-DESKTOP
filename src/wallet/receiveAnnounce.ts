import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'

/**
 * Tell the shell that money landed.
 *
 * The mobile shell turns `handcash:receive` into a system notification
 * (`HANDCASH-MOBILE/src/backgroundRuntime.ts`, `handcash-receive-v2`); Desktop
 * ignores it. Legacy-address sweeps and item arrivals already dispatched it,
 * but coin receives that only raised a toast were silent on a phone — which is
 * exactly where a receive arriving in the background needs to be heard.
 *
 * Toast and sound stay with the caller: each receive path has its own view on
 * whether the balance actually rose, and announcing twice is worse than late.
 */
export function announceCoinsReceived(sats: number): void {
  const credited = Math.max(0, Math.trunc(sats))
  const amountLabel =
    credited > 0 ? formatPrimaryFromSats(credited, getDisplayCurrency()) : undefined
  try {
    document.dispatchEvent(
      new CustomEvent('handcash:receive', {
        detail: {
          title: 'Payment received',
          body: amountLabel ?? 'Your wallet has been updated',
        },
      }),
    )
  } catch {
    // Node tests / no DOM
  }
}
