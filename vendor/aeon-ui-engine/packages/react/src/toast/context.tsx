import { createContext, useContext, type ReactNode } from 'react'

export type ToastPublishOptions = {
  id?: string
  title?: ReactNode
  description?: ReactNode
  /** Auto-dismiss after ms (0 = no auto dismiss). Default 5000. */
  durationMs?: number
}

export type ToastRecord = ToastPublishOptions & { id: string }

export type ToastStore = {
  items: ToastRecord[]
  publish: (options: ToastPublishOptions) => string
  dismiss: (id: string) => void
  dismissAll: () => void
}

export const ToastStoreCtx = createContext<ToastStore | null>(null)

export function useToastStore(): ToastStore {
  const ctx = useContext(ToastStoreCtx)
  if (!ctx) {
    throw new Error('useToast must be used within Toast.Provider')
  }
  return ctx
}
