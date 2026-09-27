import { partOnlyAttrs, scopeAttrs } from '@aeon-ui/core'
import { createElement, Fragment, type ReactNode } from 'react'
import type { Widget } from './widget.js'

export type WidgetHosts = Record<string, () => ReactNode>

/**
 * Element layer: turn a widget tree into DOM. Anatomy comes from
 * `@aeon-ui/core`, so product CSS restyles `data-aeon-*` and nothing else
 * is introduced. Hosts are the escape for existing compounds (Prompt, a
 * password field) — the tree names the slot, the app supplies the compound.
 */
export function interpret(widget: Widget, hosts: WidgetHosts): ReactNode {
  if (widget.type === 'text') return widget.text
  if (widget.type === 'host') return hosts[widget.id]?.() ?? null

  const attrs = widget.scope
    ? scopeAttrs(widget.scope, widget.part ?? 'root', { state: widget.state })
    : widget.part
      ? partOnlyAttrs(widget.part, { state: widget.state })
      : widget.state
        ? { 'data-aeon-state': widget.state }
        : {}

  const props: Record<string, unknown> = {
    ...attrs,
    className: widget.className,
    role: widget.role,
    disabled: widget.disabled || undefined,
    type: widget.tag === 'button' ? widget.buttonType ?? 'button' : undefined,
    onSubmit:
      widget.tag === 'form' && widget.onSubmit
        ? (event: { preventDefault(): void }) => widget.onSubmit?.(event)
        : undefined,
    onClick: widget.onClick,
  }

  return createElement(
    widget.tag,
    props,
    ...widget.children.map((child, index) =>
      createElement(Fragment, { key: index }, interpret(child, hosts)),
    ),
  )
}
