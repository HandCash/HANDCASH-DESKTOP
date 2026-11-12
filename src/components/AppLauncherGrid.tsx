import { Button } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { appLauncherMachine } from '../machines/appLauncherMachine'
import type { LauncherTile } from '../apps/launcherTiles'
import { openAppDetails, openAppLaunch, openChartApp, openNativeApp } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { AppAvatar } from './AppAvatar'
import { FileIcon, LaunchIcon, SettingsIcon } from './icons'
import { settingIconFor } from './settings'

function launch(tile: LauncherTile): void {
  playWalletSound('soft')
  if (tile.kind === 'native') openNativeApp(tile.appId)
  else if (tile.kind === 'chart') openChartApp(tile.appId)
  else if (tile.home) openAppLaunch(tile.origin, tile.home)
  else openAppDetails(tile.app)
}

function TileIcon({ tile }: { tile: LauncherTile }) {
  if (tile.kind === 'peer') return <AppAvatar origin={tile.origin} name={tile.label} size="md" />
  return (
    <span className="app-launcher-glyph" aria-hidden="true">
      {tile.kind === 'native' ? <FileIcon size={22} /> : settingIconFor('chart-apps').icon}
    </span>
  )
}

/**
 * Apps launcher: square tiles on a cell grid. The first tap grows a tile two
 * cells wide to show its label; tapping it again opens it (`appLauncherMachine`).
 */
export function AppLauncherGrid({ tiles }: { tiles: readonly LauncherTile[] }) {
  const byId = useRef(new Map<string, LauncherTile>())
  useLayoutEffect(() => {
    byId.current = new Map(tiles.map((t) => [t.id, t]))
  }, [tiles])
  const machine = useMemo(
    () =>
      appLauncherMachine.provide({
        actions: {
          launch: (_, { id }) => {
            const tile = byId.current.get(id)
            if (tile) launch(tile)
          },
        },
      }),
    [],
  )
  const [snapshot, send] = useMachine(machine)
  const { focused } = snapshot.context

  return (
    <ul
     
      data-aeon-scope="app-launcher"
      data-aeon-state={stateToAttr(snapshot.value)}
      onClick={(event) => {
        if (event.target === event.currentTarget) send({ type: 'DISMISS' })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') send({ type: 'DISMISS' })
      }}
    >
      {tiles.map((tile) => {
        const open = focused === tile.id
        return (
          <li key={tile.id} data-aeon-part="cell" data-aeon-state={open ? 'focused' : 'idle'}>
            <button
              type="button"
              data-aeon-part="tile"
              data-kind={tile.kind}
              aria-label={open ? `Open ${tile.label}` : tile.label}
              aria-expanded={open}
              title={tile.label}
              onClick={() => send({ type: 'TAP', id: tile.id })}
            >
              <TileIcon tile={tile} />
              <span data-aeon-part="label" aria-hidden={!open}>
                {tile.label}
              </span>
            </button>
            {open ? (
              <div data-aeon-part="actions">
                {tile.kind === 'peer' ? (
                  <Button.Root
                    variant="ghost"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Manage ${tile.label}`}
                    title={`Manage ${tile.label}`}
                    onClick={() => openAppDetails(tile.app)}
                  >
                    <SettingsIcon size={17} />
                  </Button.Root>
                ) : null}
                <Button.Root
                  variant="ghost"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Launch ${tile.label}`}
                  title={`Launch ${tile.label}`}
                  onClick={() => send({ type: 'TAP', id: tile.id })}
                >
                  <LaunchIcon size={17} />
                </Button.Root>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
