/**
 * The ETag a conditional PUT should send back. Cloudflare weakens a strong
 * ETag (`W/"…"`) when it compresses a GET, and the host compares `If-Match`
 * against the stored strong form, so a weak echo would 412 forever.
 */
export function ifMatchEtag(header: string | null): string | null {
  const etag = header?.trim()
  return etag ? etag.replace(/^W\//, '') : null
}
