import { appDisplayName, appHomepage, type AppPermissionScope } from './appIdentity'
import type { ConnectedApp } from './permissions'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function sinceText(ts: number, now: number): string {
  const ago = Math.max(0, now - ts)
  if (ago < MINUTE) return 'just now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`
  if (ago < 7 * DAY) {
    const days = Math.floor(ago / DAY)
    return days === 1 ? 'yesterday' : `${days} days ago`
  }
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** When the app was last used, or when it was connected if it never was. */
export function appSeenText(connectedAt: number, lastActivityAt: number, now: number): string {
  return lastActivityAt > 0
    ? `Used ${sinceText(lastActivityAt, now)}`
    : `Connected ${sinceText(connectedAt, now)}`
}

/** What the app can reach, in one line: the grants beyond plain wallet access, else that base. */
export function appAccessText(scopes: readonly AppPermissionScope[]): string {
  const extra = scopes.filter((scope) => scope.id !== 'wallet-access')
  return (extra.length ? extra : scopes).map((scope) => scope.label).join(' · ')
}

export function filterConnectedApps(apps: readonly ConnectedApp[], query: string): ConnectedApp[] {
  const q = query.trim().toLowerCase()
  if (!q) return apps.slice()
  return apps.filter((app) => {
    const name = (app.name || appDisplayName(app.origin)).toLowerCase()
    const home = (appHomepage(app.origin) ?? '').toLowerCase()
    return name.includes(q) || app.origin.toLowerCase().includes(q) || home.includes(q)
  })
}
