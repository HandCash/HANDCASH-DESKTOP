import { assign, setup, type SnapshotFrom } from 'xstate'
import type { ImportSourceKind } from '../wallet/import'

/**
 * Settings → Import chart.
 *
 * The section is a vault of legacy wallets, not a sweep wizard: the list is
 * home, a source opens into a read-only view, and value moves only through
 * `reviewing → CONFIRM → sweeping`. There is no transition into `sweeping`
 * from saving or scanning — a sweep is always the user's explicit confirm on
 * a preview. Removing a source is its own confirm.
 *
 * A HandCash source can wait for the user's HandCash account history: the
 * migrate page signs in and hands it over the bridge (`HINTS`), which starts
 * a scan that reads that history first. Hints never move anything.
 */
export type LegacyImportEvent =
  | { type: 'LOADED' }
  | { type: 'ADD' }
  | { type: 'PICK'; kind: ImportSourceKind }
  | { type: 'SUBMIT' }
  | { type: 'SAVED'; sourceId: string }
  | { type: 'OPEN'; sourceId: string }
  | { type: 'RESCAN' }
  | { type: 'ASK_HINTS' }
  | { type: 'HINTS' }
  | { type: 'SCANNED' }
  | { type: 'PROBE_HANDLE' }
  | { type: 'PROBED' }
  | { type: 'REVIEW' }
  | { type: 'CONFIRM' }
  | { type: 'SWEPT' }
  | { type: 'REMOVE' }
  | { type: 'REMOVED' }
  | { type: 'PROGRESS'; message: string; percent: number | null }
  | { type: 'PAUSE' }
  | { type: 'FAIL'; error: string }
  | { type: 'BACK' }

export type LegacyImportContext = {
  kind: ImportSourceKind | null
  sourceId: string | null
  error: string | null
  progress: string | null
  percent: number | null
  /** Long work polls this between batches; set by PAUSE. */
  stopRequested: boolean
}

const INITIAL: LegacyImportContext = {
  kind: null,
  sourceId: null,
  error: null,
  progress: null,
  percent: null,
  stopRequested: false,
}

export const legacyImportMachine = setup({
  types: {
    context: {} as LegacyImportContext,
    events: {} as LegacyImportEvent,
  },
  actions: {
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
    clearError: assign({ error: null }),
    pick: assign(({ event }) => (event.type === 'PICK' ? { kind: event.kind, error: null } : {})),
    select: assign(({ event }) =>
      event.type === 'SAVED' || event.type === 'OPEN'
        ? { sourceId: event.sourceId, error: null }
        : {},
    ),
    beginWork: assign({ progress: null, percent: null, stopRequested: false, error: null }),
    endWork: assign({ progress: null, percent: null, stopRequested: false }),
    progress: assign(({ event }) =>
      event.type === 'PROGRESS' ? { progress: event.message, percent: event.percent } : {},
    ),
    requestStop: assign({ stopRequested: true }),
    leaveSource: assign({ sourceId: null, kind: null, error: null }),
  },
}).createMachine({
  id: 'legacyImport',
  initial: 'loading',
  context: INITIAL,
  states: {
    loading: {
      on: {
        LOADED: { target: 'list' },
        FAIL: { target: 'list', actions: 'fail' },
      },
    },
    /** Saved sources, HandCash first in the add picker. */
    list: {
      entry: 'leaveSource',
      on: {
        ADD: { target: 'picking' },
        // The migrate page opens key recovery with the kind already chosen.
        PICK: { target: 'entering', actions: 'pick' },
        OPEN: { target: 'source', actions: 'select' },
        FAIL: { actions: 'fail' },
      },
    },
    picking: {
      on: {
        PICK: { target: 'entering', actions: 'pick' },
        BACK: { target: 'list' },
      },
    },
    /** Secret entry for the picked kind. Nothing is stored until SUBMIT. */
    entering: {
      on: {
        SUBMIT: { target: 'saving', actions: 'clearError' },
        BACK: { target: 'picking', actions: 'clearError' },
        FAIL: { actions: 'fail' },
      },
    },
    saving: {
      on: {
        SAVED: { target: 'source.scanning', actions: 'select' },
        FAIL: { target: 'entering', actions: 'fail' },
      },
    },
    /** One saved source: view, scan, prove a handle, or sweep on confirm. */
    source: {
      initial: 'viewing',
      states: {
        viewing: {
          on: {
            RESCAN: { target: 'scanning' },
            ASK_HINTS: { target: 'awaitingHints', actions: 'clearError' },
            PROBE_HANDLE: { target: 'probing', actions: 'clearError' },
            REVIEW: { target: 'reviewing', actions: 'clearError' },
            REMOVE: { target: 'confirmingRemove', actions: 'clearError' },
            BACK: { target: '#legacyImport.list' },
          },
        },
        /** The migrate page is open in the browser; the user signs in there. */
        awaitingHints: {
          on: {
            HINTS: { target: 'scanning' },
            FAIL: { target: 'viewing', actions: 'fail' },
            BACK: { target: 'viewing' },
          },
        },
        scanning: {
          entry: 'beginWork',
          exit: 'endWork',
          on: {
            PROGRESS: { actions: 'progress' },
            PAUSE: { actions: 'requestStop' },
            SCANNED: { target: 'viewing' },
            FAIL: { target: 'viewing', actions: 'fail' },
          },
        },
        probing: {
          on: {
            PROBED: { target: 'viewing' },
            FAIL: { target: 'viewing', actions: 'fail' },
          },
        },
        /** Preview of exactly what moves and what stays. */
        reviewing: {
          on: {
            CONFIRM: { target: 'sweeping' },
            BACK: { target: 'viewing' },
          },
        },
        sweeping: {
          entry: 'beginWork',
          exit: 'endWork',
          on: {
            PROGRESS: { actions: 'progress' },
            PAUSE: { actions: 'requestStop' },
            SWEPT: { target: 'viewing' },
            FAIL: { target: 'viewing', actions: 'fail' },
          },
        },
        confirmingRemove: {
          on: {
            CONFIRM: { target: 'removing' },
            BACK: { target: 'viewing' },
          },
        },
        removing: {
          on: {
            REMOVED: { target: '#legacyImport.list' },
            FAIL: { target: 'viewing', actions: 'fail' },
          },
        },
      },
    },
  },
})

export type LegacyImportSnapshot = SnapshotFrom<typeof legacyImportMachine>
