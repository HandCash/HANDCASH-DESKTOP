import { toastAnatomy, partAttrs } from '@aeon-ui/core'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { mergeProps } from '../utils/merge-props.js'
import {
  ToastStoreCtx,
  type ToastPublishOptions,
  type ToastRecord,
  useToastStore,
} from './context.js'
import { ToastItem } from './toast-item.js'

export type ToastPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'

const PLACEMENT_ATTR: Record<ToastPlacement, string> = {
  'top-start': 'top-start',
  'top-end': 'top-end',
  'bottom-start': 'bottom-start',
  'bottom-end': 'bottom-end',
}

function nextToastId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export interface ToastProviderProps {
  children?: ReactNode
  /** Max simultaneous toasts (oldest removed). Default 5. */
  limit?: number
}

export function ToastProvider({ children, limit = 5 }: ToastProviderProps) {
  const [items, setItems] = useState<ToastRecord[]>([])

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const dismissAll = useCallback(() => {
    setItems([])
  }, [])

  const publish = useCallback(
    (options: ToastPublishOptions) => {
      const id = options.id ?? nextToastId()
      const record: ToastRecord = { ...options, id }
      setItems((prev) => {
        const without = prev.filter((t) => t.id !== id)
        const next = [...without, record]
        return next.length > limit ? next.slice(-limit) : next
      })
      return id
    },
    [limit],
  )

  const value = useMemo(
    () => ({ items, publish, dismiss, dismissAll }),
    [items, publish, dismiss, dismissAll],
  )

  return <ToastStoreCtx.Provider value={value}>{children}</ToastStoreCtx.Provider>
}

export interface ToastViewportProps extends HTMLAttributes<HTMLDivElement> {
  placement?: ToastPlacement
}

export function ToastViewport({ placement = 'bottom-end', className, ...rest }: ToastViewportProps) {
  const { items, dismiss } = useToastStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return createPortal(
    <div
      {...mergeProps(
        partAttrs(toastAnatomy.scope, toastAnatomy.viewport, {
          state: items.length > 0 ? 'active' : 'idle',
        }),
        {
          'data-placement': PLACEMENT_ATTR[placement],
        },
        rest,
      )}
      className={className}
    >
      {items.map((item) => (
        <ToastItem key={item.id} item={item} onExited={dismiss} />
      ))}
    </div>,
    document.body,
  )
}

/** Imperative toast API — requires `Toast.Provider` ancestor. */
export function useToast() {
  const { publish, dismiss, dismissAll } = useToastStore()
  return { publish, dismiss, dismissAll }
}
