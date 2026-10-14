import { assign, fromPromise, setup } from 'xstate'
import type { IssuerIdentityFields, IssuerIdentityImage } from '../wallet/issuerIdentity'
import type { IdentityPublishPlan, IdentityPublishRequest } from '../wallet/identityPublish'

/** Wallet calls the chart invokes; the panel binds them to the current account. */
export type IdentityPublishPorts = {
  /** Sign and keep the identity key's own profile (BRC-248 §2): no transaction, no fee. */
  save: (identityKey: string, fields: IssuerIdentityFields, image: IssuerIdentityImage | null) => Promise<unknown>
  quote: (request: IdentityPublishRequest) => Promise<IdentityPublishPlan>
  publish: (request: IdentityPublishRequest, plan: IdentityPublishPlan) => Promise<unknown>
}

type Draft = {
  identityKey: string | null
  fields: IssuerIdentityFields
  image: IssuerIdentityImage | null
}

type Context = Draft & {
  ports: IdentityPublishPorts
  /** The BAP record being quoted, reviewed or signed; frozen until the review ends. */
  request: IdentityPublishRequest | null
  plan: IdentityPublishPlan | null
  error: string | null
}

const blank = (): Draft => ({
  identityKey: null,
  fields: { name: '', description: '' },
  image: null,
})

const idle = { request: null, plan: null, error: null }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Chart: publicIdentities
 * States: browsing | importing | composing → saving → browsing;
 *         browsing → quoting → reviewing → publishing → browsing;
 *         saving → composing (error); quoting | publishing → refused → browsing
 * Events: COMPOSE, IMPORT_KEY, FIELD, IMAGE, CLEAR_IMAGE, CLOSE, SAVE,
 *         PUBLISH_BAP, ROTATE, LINK, APPROVE, CANCEL, DISMISS
 *
 * A profile is the identity key's own signed certificate: SAVE signs it in
 * `saving`, with no transaction. A BAP record (the optional mirror, its key
 * rotation, its link) is a transaction: nothing is signed outside
 * `publishing`, which is reached only by APPROVE on a quoted plan; the wallet
 * re-derives that plan under the spend lock and refuses when it moved. No
 * private keys in chart context.
 */
export const publicIdentitiesMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { ports: IdentityPublishPorts },
    tags: {} as 'review' | 'busy',
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
      | { type: 'CLEAR_IMAGE' }
      | { type: 'CLOSE' }
      | { type: 'SAVE' }
      | {
          type: 'PUBLISH_BAP'
          identityKey: string
          fields: IssuerIdentityFields
          image: IssuerIdentityImage
        }
      | { type: 'ROTATE'; identityKey: string }
      | { type: 'LINK'; identityKey: string }
      | { type: 'APPROVE' }
      | { type: 'CANCEL' }
      | { type: 'DISMISS' },
  },
  actors: {
    save: fromPromise(({ input }: { input: { ports: IdentityPublishPorts } & Draft }) =>
      input.ports.save(input.identityKey!, input.fields, input.image),
    ),
    quote: fromPromise(
      ({ input }: { input: { ports: IdentityPublishPorts; request: IdentityPublishRequest } }) =>
        input.ports.quote(input.request),
    ),
    publish: fromPromise(
      ({
        input,
      }: {
        input: { ports: IdentityPublishPorts; request: IdentityPublishRequest; plan: IdentityPublishPlan }
      }) => input.ports.publish(input.request, input.plan),
    ),
  },
  guards: {
    draftNamed: ({ context }) => !!context.identityKey && !!context.fields.name.trim(),
  },
  actions: {
    clear: assign(() => ({ ...blank(), ...idle })),
    compose: assign(({ event }) =>
      event.type === 'COMPOSE'
        ? {
            identityKey: event.identityKey,
            fields: { ...(event.fields ?? blank().fields) },
            image: event.image ?? null,
            error: null,
          }
        : {},
    ),
    field: assign(({ context, event }) =>
      event.type === 'FIELD'
        ? { fields: { ...context.fields, [event.field]: event.value }, error: null }
        : {},
    ),
    image: assign(({ event }) => (event.type === 'IMAGE' ? { image: event.image, error: null } : {})),
    clearImage: assign(() => ({ image: null, error: null })),
    requestBap: assign(({ event }) =>
      event.type === 'PUBLISH_BAP'
        ? {
            request: {
              kind: 'profile' as const,
              identityKey: event.identityKey,
              fields: { ...event.fields },
              image: event.image,
            },
            plan: null,
            error: null,
          }
        : {},
    ),
    requestRotate: assign(({ event }) =>
      event.type === 'ROTATE'
        ? { request: { kind: 'rotate' as const, identityKey: event.identityKey }, plan: null, error: null }
        : {},
    ),
    requestLink: assign(({ event }) =>
      event.type === 'LINK'
        ? { request: { kind: 'link' as const, identityKey: event.identityKey }, plan: null, error: null }
        : {},
    ),
  },
}).createMachine({
  id: 'publicIdentities',
  initial: 'browsing',
  context: ({ input }) => ({ ...blank(), ...idle, ports: input.ports }),
  states: {
    browsing: {
      on: {
        COMPOSE: { target: 'composing', actions: 'compose' },
        IMPORT_KEY: { target: 'importing', actions: 'clear' },
        PUBLISH_BAP: { target: 'quoting', actions: 'requestBap' },
        ROTATE: { target: 'quoting', actions: 'requestRotate' },
        LINK: { target: 'quoting', actions: 'requestLink' },
      },
    },
    composing: {
      on: {
        FIELD: { actions: 'field' },
        IMAGE: { actions: 'image' },
        CLEAR_IMAGE: { actions: 'clearImage' },
        SAVE: { guard: 'draftNamed', target: 'saving' },
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    saving: {
      tags: 'busy',
      invoke: {
        src: 'save',
        input: ({ context }) => ({
          ports: context.ports,
          identityKey: context.identityKey,
          fields: { ...context.fields },
          image: context.image,
        }),
        onDone: { target: 'browsing', actions: 'clear' },
        onError: {
          target: 'composing',
          actions: assign({ error: ({ event }) => message(event.error) }),
        },
      },
    },
    importing: {
      on: {
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    quoting: {
      tags: ['review', 'busy'],
      invoke: {
        src: 'quote',
        input: ({ context }) => ({ ports: context.ports, request: context.request! }),
        onDone: {
          target: 'reviewing',
          actions: assign({ plan: ({ event }) => event.output }),
        },
        onError: {
          target: 'refused',
          actions: assign({ error: ({ event }) => message(event.error) }),
        },
      },
      on: {
        CANCEL: { target: 'browsing', actions: 'clear' },
      },
    },
    reviewing: {
      tags: ['review', 'busy'],
      on: {
        APPROVE: 'publishing',
        CANCEL: { target: 'browsing', actions: 'clear' },
      },
    },
    publishing: {
      tags: ['review', 'busy'],
      invoke: {
        src: 'publish',
        input: ({ context }) => ({
          ports: context.ports,
          request: context.request!,
          plan: context.plan!,
        }),
        onDone: { target: 'browsing', actions: 'clear' },
        onError: {
          target: 'refused',
          actions: assign({ plan: null, error: ({ event }) => message(event.error) }),
        },
      },
    },
    refused: {
      tags: ['review', 'busy'],
      on: {
        DISMISS: { target: 'browsing', actions: 'clear' },
      },
    },
  },
})
