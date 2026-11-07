import { setup } from 'xstate'

/** Fiat currency dropdown: closed or open. Picking a currency closes it. */
export const fiatCurrencyMenuMachine = setup({
  types: {
    events: {} as { type: 'TOGGLE' } | { type: 'CLOSE' } | { type: 'CHOOSE'; code: string },
  },
  actions: {
    /** Provided by the projection: apply the chosen currency. */
    applyChoice: () => {},
  },
}).createMachine({
  id: 'fiatCurrencyMenu',
  initial: 'closed',
  states: {
    closed: { on: { TOGGLE: 'open' } },
    open: {
      on: {
        TOGGLE: 'closed',
        CLOSE: 'closed',
        CHOOSE: { target: 'closed', actions: 'applyChoice' },
      },
    },
  },
})
