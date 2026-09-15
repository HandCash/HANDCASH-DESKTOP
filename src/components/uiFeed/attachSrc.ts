export function shouldAttachDeferredSrc(args: {
  retained: boolean
  near: boolean
  loadSlot: boolean
  intersecting: boolean
  ready: boolean
}): boolean {
  if (args.retained) return true
  // Never drop src while the frame is on screen — that paints an empty square.
  if (args.intersecting && (args.ready || args.loadSlot || args.near)) return true
  return args.near && args.loadSlot
}
