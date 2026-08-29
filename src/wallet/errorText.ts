/**
 * Turn a thrown value, JSON-RPC body, or MarketListingError-shaped object
 * into a sentence. Never returns "[object Object]".
 */
const OBJECT_KEYS = ['description', 'error', 'message', 'code', 'reason'] as const

function firstString(record: Record<string, unknown>): string | undefined {
  for (const key of OBJECT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of OBJECT_KEYS) {
      const nested = record[key]
      if (typeof nested === 'string' && nested.trim()) return nested
      if (
        (key === 'error' || key === 'description') &&
        nested &&
        typeof nested === 'object' &&
        !Array.isArray(nested)
      ) {
        const unwrapped = firstString(nested as Record<string, unknown>)
        if (unwrapped) return unwrapped
      }
    }
    try {
      return JSON.stringify(value)
    } catch {
      return 'Unknown error'
    }
  }
  if (value == null) return ''
  return String(value)
}

/** JSON error body for BRC-100: description is always a string. */
export function flattenJsonError(error: unknown): { code?: string; description: string } {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null
  const code = typeof record?.code === 'string' && record.code.trim() ? record.code.trim() : undefined
  let description = errorText(error)
  if (description === '[object Object]' && record) {
    description = errorText({ ...record, message: undefined }) || description
  }
  return {
    ...(code ? { code } : {}),
    description: description || 'Request failed',
  }
}
