import type { AsyncContext } from '@aeon-ui/primitives'
import { createAsyncMachine } from '@aeon-ui/primitives'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'

const defaultMachine = createAsyncMachine()

export interface AsyncProviderValue {
  status: string
  data: unknown
  error: string | null
  stale: boolean
  stateAttr: string
  send: ReturnType<typeof useAeonMachine<typeof defaultMachine>>[1]
}

const AsyncCtx = createContext<AsyncProviderValue | null>(null)

export function useAsyncContext(): AsyncProviderValue {
  const ctx = useContext(AsyncCtx)
  if (!ctx) {
    throw new Error('Async compound components must be used within <Async.Root>')
  }
  return ctx
}

export interface AsyncProviderProps {
  children: ReactNode
  machine?: typeof defaultMachine
}

export function AsyncProvider({ children, machine }: AsyncProviderProps) {
  const resolvedMachine = machine ?? defaultMachine
  const [snapshot, send] = useAeonMachine(resolvedMachine)
  const status = String(snapshot.value)
  const { data, error, stale } = snapshot.context as AsyncContext
  const stateAttr = stale && status === 'success' ? `${status} stale` : status

  const value = useMemo<AsyncProviderValue>(
    () => ({
      send,
      status,
      data,
      error,
      stale: Boolean(stale),
      stateAttr,
    }),
    [send, status, data, error, stale, stateAttr],
  )

  return <AsyncCtx.Provider value={value}>{children}</AsyncCtx.Provider>
}

export type { AsyncEvent } from '@aeon-ui/primitives'
