/**
 * Screen sharing in calls: the renderer lists screens and windows, the user
 * picks one in the app's own picker, and only then does `getDisplayMedia`
 * get that one source. Nothing is captured without a pick made moments
 * before, and only the main app frame may ask.
 */

export type ScreenSourceKind = 'screen' | 'window'

export type ScreenSourceView = {
  id: string
  name: string
  kind: ScreenSourceKind
  /** A PNG data URL of the source, for the picker. */
  thumbnail: string
}

type NativeImageLike = { isEmpty(): boolean; toDataURL(): string }

export type DesktopSourceLike = { id: string; name: string; thumbnail: NativeImageLike }

/** How long a pick stays good for the `getDisplayMedia` call that follows it. */
export const SCREEN_PICK_MS = 15_000

export function screenSourceKind(id: string): ScreenSourceKind {
  return id.startsWith('screen:') ? 'screen' : 'window'
}

/** Screens first, then windows, leaving out HandCash's own windows. */
export function toScreenSourceViews(sources: DesktopSourceLike[], ownWindowIds: string[] = []): ScreenSourceView[] {
  const own = new Set(ownWindowIds)
  return sources
    .filter((s) => !own.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name.trim() || (screenSourceKind(s.id) === 'screen' ? 'Screen' : 'Window'),
      kind: screenSourceKind(s.id),
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1))
}

export function isScreenSourceId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 200 && /^(screen|window):[\w:.-]+$/.test(v)
}

/** The one pick waiting for its capture: taken once, and only while fresh. */
export function createScreenPick(now: () => number = Date.now) {
  let pending: { id: string; at: number } | null = null
  return {
    choose(id: string): void {
      pending = { id, at: now() }
    },
    take(): string | null {
      const p = pending
      pending = null
      if (!p || now() - p.at > SCREEN_PICK_MS) return null
      return p.id
    },
  }
}
