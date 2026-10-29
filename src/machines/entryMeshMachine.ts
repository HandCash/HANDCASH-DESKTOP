import { setup } from 'xstate'

/** Parallax planes this one chart owns (far → near). Physics stays pure. */
export const ENTRY_MESH_LAYER_COUNT = 2

export type EntryMeshContext = {
  /** Near + one far plane under this chart — not one actor per layer. */
  layerCount: number
}

export type EntryMeshEvent =
  | { type: 'BOOT_STATIC' }
  | { type: 'BOOT_PLAY' }
  | { type: 'HIDE' }
  | { type: 'SHOW' }
  | { type: 'REDUCE' }

/**
 * Chart: entryMesh — Items Market mesh reverse-decomposed as one Aeon chart.
 * Context.layerCount owns the near + far planes; canvas step/paint stay pure
 * (no per-frame chart events). booting → static | playing ↔ paused.
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
