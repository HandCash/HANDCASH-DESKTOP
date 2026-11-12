/**
 * What the Apps launcher shows, in order: the wallet's native apps, the
 * built-in chart apps that verify, then connected peer apps. A chart app that
 * fails verification stays out of the launcher; Settings → Apps says why.
 */

import type { BuiltinApp } from './builtin'
import type { ConnectedApp } from '../wallet/permissions'
import { appDisplayName, appHomepage } from '../wallet/appIdentity'

export type NativeAppId = 'notes'

export type LauncherTile =
  | { id: string; kind: 'native'; appId: NativeAppId; label: string }
  | { id: string; kind: 'chart'; appId: string; label: string }
  | { id: string; kind: 'peer'; origin: string; home: string | null; label: string; app: ConnectedApp }

export const NATIVE_APPS: ReadonlyArray<{ appId: NativeAppId; label: string }> = [
  { appId: 'notes', label: 'Notes' },
]

export function launcherTiles(charts: readonly BuiltinApp[], peers: readonly ConnectedApp[]): LauncherTile[] {
  const native = NATIVE_APPS.map(({ appId, label }): LauncherTile => ({ id: `native:${appId}`, kind: 'native', appId, label }))
  const chart = charts.flatMap((app): LauncherTile[] =>
    app.verification.ok
      ? [{ id: `chart:${app.id}`, kind: 'chart', appId: app.id, label: app.verification.chart.name }]
      : [],
  )
  const peer = peers.map(
    (app): LauncherTile => ({
      id: `peer:${app.origin}`,
      kind: 'peer',
      origin: app.origin,
      home: appHomepage(app.origin),
      label: app.name || appDisplayName(app.origin),
      app,
    }),
  )
  return [...native, ...chart, ...peer]
}
