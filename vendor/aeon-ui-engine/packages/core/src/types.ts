/** Stable conditions the machine may occupy — mutually exclusive at a given depth. */
export type AeonStateValue = string | { [key: string]: AeonStateValue }

/** Events that may cause transitions. */
export type AeonEvent = { type: string } & Record<string, unknown>

/**
 * Machine context at a snapshot. Presentation is derived from this plus the active
 * state value — never the other way around.
 */
export type AeonContext<T extends Record<string, unknown> = Record<string, unknown>> = T

/**
 * Attribute contract for unstyled parts. `data-aeon-state` should enumerate the
 * full stable condition (e.g. `open`, `checked`, `idle loading`) so styles and
 * assistive tech reflect the complete machine definition, not a partial guess.
 */
export interface AeonDataAttrs {
  'data-aeon-scope': string
  'data-aeon-part': string
  'data-aeon-state'?: string
  'data-disabled'?: string
  'data-focus'?: string
  'data-highlighted'?: string
}
