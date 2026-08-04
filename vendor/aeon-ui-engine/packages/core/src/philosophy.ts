/**
 * Aeon north star: behavior is defined as explicit state first; the interface must
 * express the **totality** of that definition — every stable condition the model allows,
 * and nothing the model does not allow.
 */
export const AEON_PRINCIPLE =
  'State is defined first. UI represents the totality of that definition.' as const

/** Shorthand used in docs and APIs. */
export const UI_IS_FUNCTION_OF_STATE = 'UI = f(state)' as const
