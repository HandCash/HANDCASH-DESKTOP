import { setup } from 'xstate'

/** Single payment-mesh plane this chart owns. Physics stays pure. */
export const ENTRY_MESH_LAYER_COUNT = 1

export type EntryMeshContext = {
  /** One plane under this chart — partners-style mesh, no parallax stack. */
  layerCount: number
}

export type EntryMeshEvent =
  | { type: 'BOOT_STATIC' }
  | { type: 'BOOT_PLAY' }
  | { type: 'HIDE' }
  | { type: 'SHOW' }
  | { type: 'REDUCE' }

/**
 * Chart: entryMesh — Items Market mesh as one Aeon chart (play/static/paused).
 * AuthMeshBackground paints the single plane; this chart owns phase only.
 */
export const entryMeshMachine = setup({
  types: {
    context: {} as EntryMeshContext,
    events: {} as EntryMeshEvent,
  },
}).createMachine({
  id: 'entryMesh',
  initial: 'booting',
  context: {
    layerCount: ENTRY_MESH_LAYER_COUNT,
  },
  states: {
    booting: {
      on: {
        BOOT_STATIC: 'static',
        BOOT_PLAY: 'playing',
      },
    },
    static: {
      on: {
        // Stay frozen even if visibility flips; reduced motion wins.
      },
    },
    playing: {
      on: {
        HIDE: 'paused',
        REDUCE: 'static',
      },
    },
    paused: {
      on: {
        SHOW: 'playing',
        REDUCE: 'static',
      },
    },
  },
})
