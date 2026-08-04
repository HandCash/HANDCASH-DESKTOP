export function mergeProps(...parts: Array<object | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const props of parts) {
    if (!props) continue
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') {
        result.className = [result.className, value].filter(Boolean).join(' ')
      } else if (
        key.startsWith('on') &&
        typeof value === 'function' &&
        typeof result[key] === 'function'
      ) {
        const prev = result[key] as (...args: unknown[]) => void
        result[key] = (...args: unknown[]) => {
          prev(...args)
          ;(value as (...args: unknown[]) => void)(...args)
        }
      } else {
        result[key] = value
      }
    }
  }
  return result
}
