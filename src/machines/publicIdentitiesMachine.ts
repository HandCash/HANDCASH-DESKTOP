import { assign, setup } from 'xstate'
import type { PublicIdentityFields } from '../wallet/publicIdentityProfile'

const blank = (): PublicIdentityFields => ({
  displayName: '',
  icon: '',
  description: '',
})
/** Drafts and navigation only; asyncAction owns mutation/confirmation. No private keys in chart context. */
export const publicIdentitiesMachine = setup({
  types: {
    context: {} as { identityKey: string | null; fields: PublicIdentityFields },
    events: {} as
      | { type: 'CREATE' }
      | { type: 'IMPORT_KEY' }
      | { type: 'EDIT'; identityKey: string; fields: PublicIdentityFields }
      | { type: 'FIELD'; field: keyof PublicIdentityFields; value: string }
      | { type: 'CLOSE' },
  },
  actions: {
    clear: assign(() => ({ identityKey: null, fields: blank() })),
    edit: assign(({ event }) =>
      event.type === 'EDIT'
        ? { identityKey: event.identityKey, fields: { ...event.fields } }
        : {},
    ),
    field: assign(({ context, event }) =>
      event.type === 'FIELD'
        ? { fields: { ...context.fields, [event.field]: event.value } }
        : {},
    ),
  },
}).createMachine({
  id: 'publicIdentities',
  initial: 'browsing',
  context: { identityKey: null, fields: blank() },
  states: {
    browsing: {
      on: {
        CREATE: { target: 'editing', actions: 'clear' },
        EDIT: { target: 'editing', actions: 'edit' },
        IMPORT_KEY: { target: 'importing', actions: 'clear' },
      },
    },
    editing: {
      on: {
        FIELD: { actions: 'field' },
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    importing: {
      on: {
        FIELD: { actions: 'field' },
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
  },
})
