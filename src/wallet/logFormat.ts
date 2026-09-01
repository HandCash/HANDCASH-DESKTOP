/**
 * Shared log formatting for console capture and structured diagnostics.
 * Keep this module dependency-free so appLog and diagnosticLog can both use it.
 */

const MAX_STRING = 500
const MAX_JSON = 400

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Format one console / diagnostic field value. */
export function formatLogArg(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'string') return truncate(value, MAX_STRING)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) {
    const cap = value as Error & { code?: string }
    const code = cap.code ? ` code=${cap.code}` : ''
    const detail = cap.stack || cap.message || cap.name || 'Error'
    return truncate(`${cap.name || 'Error'}${code}: ${detail}`, MAX_STRING)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.message === 'string') {
      const code =
        typeof record.code === 'string' || typeof record.code === 'number'
          ? String(record.code)
          : ''
      const msg = record.message
      return truncate(code ? `${code}: ${msg}` : msg, MAX_STRING)
    }
    try {
      return truncate(JSON.stringify(value), MAX_JSON)
    } catch {
      return truncate(String(value), MAX_STRING)
    }
  }
  return truncate(String(value), MAX_STRING)
}

/** `key=value` pairs for structured diagnostic lines. Omits empty values. */
export function formatLogFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatLogArg(value)}`)
    .join(' ')
}
