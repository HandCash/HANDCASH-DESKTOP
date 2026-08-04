export function mergeProps(...sources: unknown[]): Record<string, unknown> {
  return Object.assign({}, ...sources) as Record<string, unknown>
}
