import { assign, fromPromise, setup } from 'xstate'
import type { IssuerIdentityFields, IssuerIdentityImage } from '../wallet/issuerIdentity'
import type { IdentityPublishPlan, IdentityPublishRequest } from '../wallet/identityPublish'

/** Wallet calls the chart invokes; the panel binds them to the current account. */
export type IdentityPublishPorts = {
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
  /** What is being quoted, reviewed or signed; frozen until the review ends. */
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
 * States: browsing | importing | composing → quoting → reviewing → publishing
 *         → browsing; quoting | publishing → refused → back
 * Events: COMPOSE, IMPORT_KEY, FIELD, IMAGE, CLOSE, REVIEW, ROTATE, APPROVE,
 *         CANCEL, DISMISS
 *
 * Nothing is signed outside `publishing`, and `publishing` is reached only by
 * APPROVE on a quoted plan; the wallet re-derives that plan under the spend
 * lock and refuses when it moved. The draft is frozen from REVIEW until the
 * review ends. No private keys in chart context.
 */
export const publicIdentitiesMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { ports: IdentityPublishPorts },
    tags: {} as 'review',
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
      | { type: 'CLOSE' }
      | { type: 'REVIEW' }
      | { type: 'ROTATE'; identityKey: string }
      | { type: 'APPROVE' }
      | { type: 'CANCEL' }
      | { type: 'DISMISS' },
  },
  actors: {
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
    draftReady: ({ context }) =>
      !!context.identityKey && !!context.image && !!context.fields.name.trim(),
    fromDraft: ({ context }) => context.request?.kind === 'profile',
  },
  actions: {
    clear: assign(() => ({ ...blank(), ...idle })),
    endReview: assign(() => idle),
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
    requestProfile: assign(({ context }) => ({
      request: {
        kind: 'profile' as const,
        identityKey: context.identityKey!,
        fields: { ...context.fields },
        image: context.image,
      },
      plan: null,
      error: null,
    })),
    requestRotate: assign(({ event }) =>
      event.type === 'ROTATE'
        ? { request: { kind: 'rotate' as const, identityKey: event.identityKey }, plan: null, error: null }
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
        ROTATE: { target: 'quoting', actions: 'requestRotate' },
      },
    },
    composing: {
      on: {
        FIELD: { actions: 'field' },
        IMAGE: { actions: 'image' },
        REVIEW: { guard: 'draftReady', target: 'quoting', actions: 'requestProfile' },
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    importing: {
      on: {
        CLOSE: { target: 'browsing', actions: 'clear' },
      },
    },
    quoting: {
      tags: 'review',
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
        CANCEL: [
          { guard: 'fromDraft', target: 'composing', actions: 'endReview' },
          { target: 'browsing', actions: 'clear' },
        ],
      },
    },
    reviewing: {
      tags: 'review',
      on: {
        APPROVE: 'publishing',
        CANCEL: [
          { guard: 'fromDraft', target: 'composing', actions: 'endReview' },
          { target: 'browsing', actions: 'clear' },
        ],
      },
    },
    publishing: {
      tags: 'review',
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
      tags: 'review',
      on: {
        DISMISS: [
          { guard: 'fromDraft', target: 'composing', actions: 'endReview' },
          { target: 'browsing', actions: 'clear' },
        ],
      },
    },
  },
})
