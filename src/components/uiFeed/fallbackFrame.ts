/**
 * The frame a fallback glyph occupies when an image never arrives.
 *
 * `.deferred-image` is an auto-sized `inline-grid`, so a glyph sizes to itself
 * and sits at the top of whatever fixed square holds it — the item placeholder
 * hugging the top edge of its 120px tile. The image it stands in for would have
 * filled that square, so the fallback takes the same frame and centres in it.
 *
 * Only while the fallback shows: a loaded image sizes itself, and forcing a
 * frame on it would override a caller's percentage layout.
 */
export function deferredFallbackFrame(args: {
  showFallback: boolean
  width?: number | string
  height?: number | string
}): { width: number | string; height: number | string } | undefined {
  if (!args.showFallback) return undefined
  return { width: args.width ?? '100%', height: args.height ?? '100%' }
}
