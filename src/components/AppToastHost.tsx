import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  dismissToast,
  subscribeToasts,
  type ToastItem,
} from '../wallet/toast'

export function AppToastHost() {
  const [mounted, setMounted] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    setMounted(true)
    return subscribeToasts(setToasts)
  }, [])

  if (!mounted || toasts.length === 0) return null

  return createPortal(
    <div
      className="aeonToast__viewport app-toast-viewport"
      data-aeon-scope="toast"
      data-aeon-part="viewport"
      data-aeon-state="active"
      data-placement="bottom-end"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="aeonToast__root app-toast"
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
          data-aeon-scope="toast"
          data-aeon-part="root"
          data-aeon-state={toast.tone}
        >
          <p className="aeonToast__title" data-aeon-part="title">
            {toast.title}
          </p>
          {toast.body ? (
            <p className="aeonToast__description" data-aeon-part="description">
              {toast.body}
            </p>
          ) : null}
          <button
            type="button"
            className="aeonToast__closeTrigger"
            data-aeon-part="closeTrigger"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
