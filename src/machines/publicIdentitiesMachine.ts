import { assign, setup } from 'xstate'
import type { IssuerIdentityFields, IssuerIdentityImage } from '../wallet/issuerIdentity'

type Draft = {
  identityKey: string | null
  fields: IssuerIdentityFields
  image: IssuerIdentityImage | null
}
const blank = (): Draft => ({
  identityKey: null,
  fields: { name: '', description: '' },
  image: null,
})
/**
 * Drafts and navigation only; asyncAction owns publishing, image encoding and
 * confirmation. No private keys in chart context.
 */
export const publicIdentitiesMachine = setup({
  types: {
    context: {} as Draft,
    events: {} as
      | {
          type: 'COMPOSE'
          identityKey: string
          fields?: IssuerIdentityFields
          image?: IssuerIdentityImage
        }
      | { type: 'IMPORT_KEY' }
      | { type: 'FIELD'; field: keyof IssuerIdentityFields; value: string }
      | { type: 'IMAGE'; image: IssuerIdentityImage }
      | { type: 'CLOSE' },
  },
  actions: {
    clear: assign(() => blank()),
    compose: assign(({ event }) =>
      event.type === 'COMPOSE'
        ? {
            identityKey: event.identityKey,
            fields: { ...(event.fields ?? blank().fields) },
            image: event.image ?? null,
          }
        : {},
    ),
    field: assign(({ context, event }) =>
      event.type === 'FIELD'
        ? { fields: { ...context.fields, [event.field]: event.value } }
        : {},
    ),
    image: assign(({ event }) => (event.type === 'IMAGE' ? { image: event.image } : {})),
  },
}).createMachine({
  id: 'publicIdentities',
  initial: 'browsing',
  context: blank(),
  states: {
    browsing: {
      on: {
        COMPOSE: { target: 'composing', actions: 'compose' },
        IMPORT_KEY: { target: 'importing', actions: 'clear' },
      },
    },
    composing: {
      on: {
        FIELD: { actions: 'field' },
        IMAGE: { actions: 'image' },
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    importing: {
      on: {
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
  },
})
