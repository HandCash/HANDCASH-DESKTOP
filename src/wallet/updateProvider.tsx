import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import { useMachine } from '@xstate/react'
import {
  updateMachine,
  updateStateAttr,
  type UpdateContext,
  type UpdateMode,
} from '../machines/updateMachine'
import { durableGetItem, durableSetItem } from './durableStorage'

const MODE_KEY = 'handcash.update.mode'

type UpdateApi = {
  context: UpdateContext
  stateAttr: string
  phase: string
  promptOpen: boolean
  check: () => Promise<void>
  setMode: (mode: UpdateMode) => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  dismissPrompt: () => void
}

const UpdateCtx = createContext<UpdateApi | null>(null)

function readStoredMode(): UpdateMode | null {
  const raw = durableGetItem(MODE_KEY)
  if (raw === 'default' || raw === 'manual' || raw === 'none') return raw
  return null
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [snapshot, send] = useMachine(updateMachine)
  const contextRef = useRef(snapshot.context)
  contextRef.current = snapshot.context

  useEffect(() => {
    const stored = readStoredMode()
    if (stored) send({ type: 'SET_MODE', mode: stored })

    const api = window.handcash
    if (!api?.getUpdateStatus || !api.onUpdateStatus) {
      void api?.getAppInfo?.().then((info) => {
        const ctx = contextRef.current
        send({
          type: 'SYNC',
          status: {
            phase: 'idle',
            mode: stored ?? ctx.mode,
            currentVersion: info.version,
            availableVersion: null,
            percent: null,
            error: null,
            canInstall: false,
          },
        })
      })
      return
    }

    let cancelled = false
    void api.getUpdateStatus().then((status) => {
      if (!cancelled) send({ type: 'SYNC', status })
    })
    const off = api.onUpdateStatus((status) => send({ type: 'SYNC', status }))
    return () => {
      cancelled = true
      off()
    }
  }, [send])

  const check = useCallback(async () => {
    send({ type: 'CHECK' })
    const api = window.handcash
    if (!api?.checkForUpdates) {
      const ctx = contextRef.current
      send({
        type: 'SYNC',
        status: {
          phase: 'error',
          mode: ctx.mode,
          currentVersion: ctx.currentVersion,
          availableVersion: null,
          percent: null,
          error: 'Updates are only checked in the packaged Desktop app.',
          canInstall: false,
        },
      })
      return
    }
    const status = await api.checkForUpdates()
    send({ type: 'SYNC', status })
  }, [send])

  const setMode = useCallback(
    async (mode: UpdateMode) => {
      durableSetItem(MODE_KEY, mode)
      send({ type: 'SET_MODE', mode })
      const api = window.handcash
      if (api?.setUpdateMode) {
        const status = await api.setUpdateMode(mode)
        send({ type: 'SYNC', status })
        return
      }
      const ctx = contextRef.current
      send({
        type: 'SYNC',
        status: {
          phase: ctx.phase,
          mode,
          currentVersion: ctx.currentVersion,
          availableVersion: ctx.availableVersion,
          percent: ctx.percent,
          error: ctx.error,
          canInstall: ctx.canInstall,
        },
      })
    },
    [send],
  )

  const download = useCallback(async () => {
    send({ type: 'DOWNLOAD' })
    const status = await window.handcash?.downloadUpdate?.()
    if (status) send({ type: 'SYNC', status })
  }, [send])

  const install = useCallback(async () => {
    send({ type: 'INSTALL' })
    await window.handcash?.installUpdate?.()
  }, [send])

  const dismissPrompt = useCallback(() => {
    send({ type: 'DISMISS_PROMPT' })
  }, [send])

  const context = snapshot.context
  const stateAttr = updateStateAttr(snapshot.value, context)
  const promptOpen =
    context.canInstall &&
    context.phase === 'ready' &&
    context.promptDismissedVersion !== context.availableVersion

  const value: UpdateApi = {
    context,
    stateAttr,
    phase: typeof snapshot.value === 'string' ? snapshot.value : context.phase,
    promptOpen,
    check,
    setMode,
    download,
    install,
    dismissPrompt,
  }

  return <UpdateCtx.Provider value={value}>{children}</UpdateCtx.Provider>
}

export function useUpdate(): UpdateApi {
  const ctx = useContext(UpdateCtx)
  if (!ctx) throw new Error('useUpdate must be used within UpdateProvider')
  return ctx
}

export type { UpdateMode, UpdatePhase, UpdateStatus } from '../machines/updateMachine'
