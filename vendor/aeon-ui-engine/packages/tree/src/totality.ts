import type { Widget } from './widget.js'

/** Every `data-aeon-state` token a tree would project. */
export function widgetStates(widget: Widget): string[] {
  if (widget.type !== 'el') return []
  const own = widget.state ? [widget.state] : []
  return [...own, ...widget.children.flatMap(widgetStates)]
}

/**
 * States the chart names that the projection never puts on the tree.
 * Totality (PHILOSOPHY.md §2): if the machine has the state, the face for
 * that state must carry it. A missing name is a face the UI forgot.
 */
export function uncoveredStates(
  states: readonly string[],
  project: (state: string) => Widget,
): string[] {
  return states.filter((state) => !widgetStates(project(state)).includes(state))
}
