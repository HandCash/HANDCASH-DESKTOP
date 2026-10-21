import { clipboardAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import { clipboardMachine, type ClipboardStatus } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface ClipboardContextValue {
  status: ClipboardStatus
  copy: () => void
}

const ClipboardCtx = createContext<ClipboardContextValue | null>(null)

function useClipboardCtx() {
  const ctx = useContext(ClipboardCtx)
  if (!ctx) throw new Error('Clipboard parts must be used within Clipboard.Root')
  return ctx
}

/** Read the copy status from any part inside Clipboard.Root. */
export const useClipboardStatus = () => useClipboardCtx().status

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const ANNOUNCE: Partial<Record<ClipboardStatus, string>> = { copied: 'Copied', failed: 'Copy failed' }

export interface ClipboardRootProps extends HTMLAttributes<HTMLDivElement> {
  /** Text written to the clipboard; read at the moment of copying. */
  value: string
  /** How long copied / failed show, in ms. */
  timeout?: number
}

const Root = forwardRef<HTMLDivElement, ClipboardRootProps>(function ClipboardRoot(
  { value, timeout, children, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(clipboardMachine, { input: { timeout } })
  const status = snapshot.value as ClipboardStatus
  const ctx = useMemo(() => ({ status, copy: () => send({ type: 'COPY', value }) }), [status, send, value])

  return (
    <ClipboardCtx.Provider value={ctx}>
      <div ref={ref} {...mergeProps(partAttrs(clipboardAnatomy.scope, clipboardAnatomy.root, { state: status }), rest)}>
        {children}
        <span role="status" style={visuallyHidden} {...partOnlyAttrs(clipboardAnatomy.status)}>
          {ANNOUNCE[status] ?? ''}
        </span>
      </div>
    </ClipboardCtx.Provider>
  )
})

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function ClipboardTrigger(
  { onClick, ...rest },
  ref,
) {
  const { status, copy } = useClipboardCtx()

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Copy"
      {...mergeProps(
        partOnlyAttrs(clipboardAnatomy.trigger, { state: status }),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            if (!e.defaultPrevented) copy()
          },
        },
        rest,
      )}
    />
  )
})

export interface ClipboardIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  /** Shown while copied; `children` show otherwise. */
  copied?: ReactNode
}

const Indicator = forwardRef<HTMLSpanElement, ClipboardIndicatorProps>(function ClipboardIndicator(
  { copied, children, ...rest },
  ref,
) {
  const { status } = useClipboardCtx()

  return (
    <span ref={ref} aria-hidden {...mergeProps(partOnlyAttrs(clipboardAnatomy.indicator, { state: status }), rest)}>
      {status === 'copied' && copied !== undefined ? copied : children}
    </span>
  )
})

export const Clipboard = { Root, Trigger, Indicator }
