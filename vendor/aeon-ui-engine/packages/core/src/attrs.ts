type AttrOptions = {
  state?: string | string[]
  disabled?: boolean
  focus?: boolean
  highlighted?: boolean
}

function stateFields(options?: AttrOptions) {
  const states = options?.state
    ? Array.isArray(options.state)
      ? options.state.join(' ')
      : options.state
    : undefined

  return {
    ...(states ? { 'data-aeon-state': states } : {}),
    ...(options?.disabled ? { 'data-disabled': '' } : {}),
    ...(options?.focus ? { 'data-focus': '' } : {}),
    ...(options?.highlighted ? { 'data-highlighted': '' } : {}),
  }
}

/** Scope + part on the component root (e.g. accordion root). */
export function scopeAttrs(
  scope: string,
  part = 'root',
  options?: AttrOptions,
): Record<string, unknown> {
  return {
    'data-aeon-scope': scope,
    'data-aeon-part': part,
    ...stateFields(options),
  }
}

/** Part only — use on children inside a scoped root. */
export function partOnlyAttrs(part: string, options?: AttrOptions): Record<string, unknown> {
  return {
    'data-aeon-part': part,
    ...stateFields(options),
  }
}

/** Build data-aeon-* attributes for styling unstyled parts. */
export function partAttrs(scope: string, part: string, options?: AttrOptions): Record<string, unknown> {
  return scopeAttrs(scope, part, options)
}
