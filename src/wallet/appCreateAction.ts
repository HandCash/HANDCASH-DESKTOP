/**
 * Third-party createAction should return once the tx is signed and packaged —
 * not after Arcade / merkle / seen-on-chain. Miner cashing runs on the shared
 * signed-send outbox after the BRC-100 reply; Arcade silence must never hold
 * the app (or demo) loading state past preparing/signing.
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
