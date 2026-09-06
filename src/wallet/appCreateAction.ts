/**
 * Third-party createAction should return once the tx is signed and handed to
 * miners — not after a seen-on-chain / merkle callback. Arcade (or any miner)
 * accepting the BEEF is enough for the app to treat the spend as complete and
 * for us to deduct change.
 */
export function withImmediateAppBroadcast(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const body = args as { options?: unknown }
  const options =
    body.options && typeof body.options === 'object' && !Array.isArray(body.options)
      ? { ...(body.options as Record<string, unknown>) }
      : {}
  return {
    ...body,
    options: {
      ...options,
      acceptDelayedBroadcast: true,
    },
  }
}
