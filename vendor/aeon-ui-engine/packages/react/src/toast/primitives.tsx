import { toastAnatomy, partAttrs } from '@aeon-ui/core'
import { toastMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface ToastContextValue {
  visible: boolean
  send: ReturnType<typeof useAeonMachine<typeof toastMachine>>[1]
  titleId: string
}

const ToastCtx = createContext<ToastContextValue | null>(null)

function useToastCtx() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('Toast parts must be used within Toast.Root')
  return ctx
}

export interface ToastRootProps {
  durationMs?: number
  defaultVisible?: boolean
  onVisibleChange?: (visible: boolean) => void
  children?: ReactNode
  className?: string
}

export const Root = forwardRef<HTMLDivElement, ToastRootProps>(function ToastRoot(
  { durationMs = 5000, defaultVisible = false, onVisibleChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(toastMachine, { input: { durationMs } })
  const visible = snapshot.matches('visible')
  const titleId = useId()
  const hasBeenVisible = useRef(false)

  useEffect(() => {
    if (defaultVisible) send({ type: 'SHOW' })
  }, [defaultVisible, send])

  useEffect(() => {
    if (visible) {
      hasBeenVisible.current = true
      onVisibleChange?.(true)
      return
    }
    if (hasBeenVisible.current) onVisibleChange?.(false)
  }, [visible, onVisibleChange])

  const value = useMemo(() => ({ visible, send, titleId }), [visible, send, titleId])

  return (
    <ToastCtx.Provider value={value}>
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        {...mergeProps(
          partAttrs(toastAnatomy.scope, toastAnatomy.root, { state: visible ? 'visible' : 'hidden' }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
        className={className}
        hidden={!visible}
      >
        {visible ? children : null}
      </div>
    </ToastCtx.Provider>
  )
})

export const Title = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(function ToastTitle(
  props,
  ref,
) {
  const { titleId } = useToastCtx()
  return (
    <p ref={ref} id={titleId} {...mergeProps(partAttrs(toastAnatomy.scope, toastAnatomy.title), props)} />
  )
})

export const Description = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function ToastDescription(props, ref) {
    return <p ref={ref} {...mergeProps(partAttrs(toastAnatomy.scope, toastAnatomy.description), props)} />
  },
)

export const CloseTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ToastCloseTrigger({ onClick, children, ...rest }, ref) {
    const { send } = useToastCtx()
    return (
      <button
        ref={ref}
        type="button"
        aria-label="Dismiss"
        {...mergeProps(
          partAttrs(toastAnatomy.scope, toastAnatomy.closeTrigger),
          {
            onClick: (e: MouseEvent<HTMLButtonElement>) => {
              onClick?.(e)
              send({ type: 'DISMISS' })
            },
          },
          rest,
        )}
      >
        {children ?? '\u00d7'}
      </button>
    )
  },
)

/** Programmatically show a declarative Toast.Root instance. */
export function Show({ durationMs }: { durationMs?: number }) {
  const { send } = useToastCtx()
  useEffect(() => {
    send({ type: 'SHOW' })
    if (durationMs !== undefined) {
      return () => send({ type: 'DISMISS' })
    }
  }, [send, durationMs])
  return null
}
