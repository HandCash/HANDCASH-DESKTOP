import { assign, setup } from 'xstate'
import type { ActivityEntry } from '../wallet/appActivity'
import type { FungibleToken } from '../wallet/fungibles'

export type FungibleDetailsInput = {
  token: FungibleToken | null
  activity: ActivityEntry[]
}

type FungibleDetailsContext = FungibleDetailsInput

type FungibleDetailsEvent =
  | { type: 'LOAD'; token: FungibleToken | null; activity: ActivityEntry[] }
  | { type: 'ACTIVITY_SYNCED'; activity: ActivityEntry[] }

export function activityForFungible(
  token: FungibleToken | null,
  entries: readonly ActivityEntry[],
): ActivityEntry[] {
  if (!token) return []
  const ids = new Set([token.tokenId, ...(token.tokenIds ?? [])].map((id) => id.trim().toLowerCase()))
  return entries.filter((entry) => {
    const id = entry.item?.tokenId?.trim().toLowerCase()
    return Boolean(id && ids.has(id))
  })
}

/**
 * Token details UI chart. The wallet stores remain authoritative; this chart
 * owns the visible loading / ready / unavailable paths and their projections.
 */
export const fungibleDetailsMachine = setup({
  types: {
    context: {} as FungibleDetailsContext,
    input: {} as FungibleDetailsInput,
    events: {} as FungibleDetailsEvent,
  },
  guards: {
    hasLoadedToken: ({ event }) => event.type === 'LOAD' && Boolean(event.token),
    hasContextToken: ({ context }) => Boolean(context.token),
  },
  actions: {
    load: assign(({ event }) =>
      event.type === 'LOAD'
        ? {
            token: event.token,
            activity: activityForFungible(event.token, event.activity),
          }
        : {},
    ),
    syncActivity: assign(({ context, event }) =>
      event.type === 'ACTIVITY_SYNCED'
        ? { activity: activityForFungible(context.token, event.activity) }
        : {},
    ),
  },
}).createMachine({
  id: 'fungibleDetails',
  initial: 'loading',
  context: ({ input }) => ({
    token: input.token,
    activity: activityForFungible(input.token, input.activity),
  }),
  states: {
    loading: {
      always: {
        guard: 'hasContextToken',
        target: 'ready',
      },
      on: {
        LOAD: [
          { guard: 'hasLoadedToken', target: 'ready', actions: 'load' },
          { target: 'unavailable', actions: 'load' },
        ],
      },
    },
    ready: {
      on: {
        ACTIVITY_SYNCED: { actions: 'syncActivity' },
        LOAD: [
          { guard: 'hasLoadedToken', actions: 'load' },
          { target: 'unavailable', actions: 'load' },
        ],
      },
    },
    unavailable: {
      on: {
        ACTIVITY_SYNCED: { actions: 'syncActivity' },
        LOAD: [
          { guard: 'hasLoadedToken', target: 'ready', actions: 'load' },
          { actions: 'load' },
        ],
      },
    },
  },
})
