import { assign, setup, type SnapshotFrom } from 'xstate'
import { normalizeAbout, normalizePersonaName } from '../wallet/sigmaIdentity/payload'
import { personaIdFromName } from '../wallet/sigmaIdentity/paths'

/**
 * Chart: identity
 *
 * Root identity and the BRC-169 handle are always on screen. They are not
 * states of this chart — a handle claim does not create a Sigma persona, and
 * a persona revoke does not touch the root.
 *
 * This chart owns the Sigma persona screen only:
 * browsing → composing → confirming → publishing → published
 * browsing → revokeConfirm → revoking
 * either spend can land in failure and return to the step that caused it.
 */
export type IdentityContext = {
  name: string
  about: string
  /** Persona being revoked. Create does not use this. */
  personaId: string | null
  error: string | null
}

export type IdentityEvent =
  | { type: 'COMPOSE' }
  | { type: 'EDIT'; name?: string; about?: string }
  | { type: 'REVIEW' }
  | { type: 'CANCEL' }
  | { type: 'BACK' }
  | { type: 'CONFIRM' }
  | { type: 'REVOKE'; personaId: string }
  | { type: 'SUCCESS' }
  | { type: 'DONE' }
  | { type: 'FAIL'; error: string }

function draftReady(name: string, about: string): boolean {
  if (!normalizePersonaName(name) || !personaIdFromName(name)) return false
  if (about.trim() && !normalizeAbout(about)) return false
  return true
}

export const identityMachine = setup({
  types: {
    context: {} as IdentityContext,
    events: {} as IdentityEvent,
  },
  actions: {
    clearDraft: assign({ name: '', about: '', personaId: null, error: null }),
    clearError: assign({ error: null }),
    edit: assign(({ context, event }) =>
      event.type === 'EDIT'
        ? {
            name: event.name ?? context.name,
            about: event.about ?? context.about,
            error: null,
          }
        : {},
    ),
    selectRevoke: assign(({ event }) =>
      event.type === 'REVOKE' ? { personaId: event.personaId, error: null } : {},
    ),
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
  },
  guards: {
    draftReady: ({ context }) => draftReady(context.name, context.about),
    failedCreate: ({ context }) => context.personaId == null,
  },
}).createMachine({
  id: 'identity',
  initial: 'browsing',
  context: { name: '', about: '', personaId: null, error: null },
  states: {
    browsing: {
      entry: 'clearDraft',
      on: {
        COMPOSE: 'composing',
        REVOKE: { target: 'revokeConfirm', actions: 'selectRevoke' },
      },
    },
    composing: {
      on: {
        EDIT: { actions: 'edit' },
        REVIEW: { target: 'confirming', guard: 'draftReady' },
        CANCEL: 'browsing',
      },
    },
    confirming: {
      on: {
        BACK: 'composing',
        CONFIRM: 'publishing',
        CANCEL: 'browsing',
      },
    },
    publishing: {
      on: {
        SUCCESS: 'published',
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    published: {
      on: { DONE: 'browsing' },
    },
    revokeConfirm: {
      on: {
        BACK: 'browsing',
        CONFIRM: 'revoking',
        CANCEL: 'browsing',
      },
    },
    revoking: {
      on: {
        SUCCESS: 'browsing',
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    failure: {
      on: {
        BACK: [
          { target: 'composing', guard: 'failedCreate' },
          { target: 'revokeConfirm' },
        ],
        CANCEL: 'browsing',
      },
    },
  },
})

export type IdentitySnapshot = SnapshotFrom<typeof identityMachine>
