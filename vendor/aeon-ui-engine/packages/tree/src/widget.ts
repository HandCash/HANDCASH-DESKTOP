/**
 * A widget is configuration, the way a Flutter `Widget` is: immutable data
 * describing one face of a chart. It holds no lifecycle. The only state it
 * may name is a snapshot already produced by a machine (`data-aeon-state`).
 *
 * Callbacks are event bindings (what to send), not state. There is no
 * equivalent of `StatefulWidget` or `setState` — a second copy of the chart
 * living in the tree would be the boolean twin this layer exists to remove.
 */
export type Widget =
  | { type: 'text'; text: string }
  | { type: 'host'; id: string }
  | {
      type: 'el'
      tag: 'div' | 'form' | 'button' | 'p' | 'span'
      scope?: string
      part?: string
      /** Chart snapshot token. Projected onto `data-aeon-state`. */
      state?: string
      className?: string
      buttonType?: 'button' | 'submit'
      disabled?: boolean
      role?: string
      onSubmit?: (event: { preventDefault(): void }) => void
      onClick?: () => void
      children: Widget[]
    }

export const text = (value: string): Widget => ({ type: 'text', text: value })

export const host = (id: string): Widget => ({ type: 'host', id })
