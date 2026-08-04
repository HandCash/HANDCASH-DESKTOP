import { AsyncActions } from './actions.js'
import { AsyncProvider } from './context.js'
import { AsyncReadout } from './readout.js'
import { AsyncRoot } from './root.js'
import { AsyncTrack } from './track.js'

export { AsyncProvider, useAsyncContext } from './context.js'
export { asyncStatusToContentState } from './map-content-state.js'
export { AsyncTrack } from './track.js'
export { AsyncReadout } from './readout.js'
export { AsyncActions } from './actions.js'
export { AsyncRoot } from './root.js'
export { createAsyncMachine } from '@aeon-ui/primitives'

/**
 * Async — fetch lifecycle driver (`createAsyncMachine`).
 * Product UI: project status with Content slots via `asyncStatusToContentState`.
 * `Track` is a totality/debug rail — not Instant default (see docs/PRIMITIVE_COVERAGE.md).
 */
export const Async = {
  Root: AsyncRoot,
  Provider: AsyncProvider,
  Track: AsyncTrack,
  Readout: AsyncReadout,
  Actions: AsyncActions,
}
