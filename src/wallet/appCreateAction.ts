/**
 * Third-party createAction should return once the tx is signed and handed to
 * miners — not after a seen-on-chain / merkle callback. Arcade (or any miner)
 * accepting the BEEF is enough for the app to treat the spend as complete and
 * for us to deduct change.
 *
 * `trustSelf: 'known'` keeps that return off the ancestry proof walk. With it
 * unset the toolbox fetches a merkle proof for every parent before it answers;
 * the first spend of a session measured 19s inside that walk. Local parent
 * bodies are merged onto the reply afterwards, which is what a chained refund
 * actually needs.
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
      ...(options.trustSelf == null ? { trustSelf: 'known' as const } : {}),
    },
  }
}
