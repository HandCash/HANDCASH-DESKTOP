import { panelAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { panelMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

type PanelState = 'expanded' | 'collapsed'

interface PanelContextValue {
  state: PanelState
  expanded: boolean
  collapsible: boolean
  label: string
  contentId: string
  send: ReturnType<typeof useAeonMachine<typeof panelMachine>>[1]
}

const PanelCtx = createContext<PanelContextValue | null>(null)

function usePanelCtx() {
  const ctx = useContext(PanelCtx)
  if (!ctx) throw new Error('Panel parts must be used within Panel.Root')
  return ctx
}

/* ------------------------------------------------------------------ */
/*  Group — horizontal/vertical split of Panel.Root siblings           */
/* ------------------------------------------------------------------ */

export interface PanelGroupProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
  children?: ReactNode
}

const Group = forwardRef<HTMLDivElement, PanelGroupProps>(function PanelGroup(
  { orientation = 'horizontal', children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={className}
      data-aeon-orientation={orientation}
      {...mergeProps(partAttrs(panelAnatomy.scope, panelAnatomy.group), rest)}
    >
      {children}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

export interface PanelRootProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible name; also the collapsed vertical rail text. */
  label: string
  /** Start expanded (default true). */
  defaultExpanded?: boolean
  /** Controlled expanded state. */
  expanded?: boolean
  /** Whether the panel can collapse (default true). */
  collapsible?: boolean
  onExpandedChange?: (expanded: boolean) => void
  children?: ReactNode
}

const Root = forwardRef<HTMLDivElement, PanelRootProps>(function PanelRoot(
  {
    label,
    defaultExpanded = true,
    expanded: expandedProp,
    collapsible = true,
    onExpandedChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const contentId = useId().replace(/:/g, '')
  const [snapshot, send] = useAeonMachine(panelMachine, {
    input: { expanded: defaultExpanded },
  })

  const machineExpanded = snapshot.value === 'expanded'
  const expanded = expandedProp ?? machineExpanded
  const state: PanelState = expanded ? 'expanded' : 'collapsed'

  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  useEffect(() => {
    if (expandedProp === undefined) return
    send({ type: 'SET_EXPANDED', expanded: expandedProp })
  }, [expandedProp, send])

  const ctx = useMemo(
    () => ({
      state,
      expanded,
      collapsible,
      label,
      contentId: `aeon-panel-${contentId}`,
      send,
    }),
    [state, expanded, collapsible, label, contentId, send],
  )

  return (
    <PanelCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          scopeAttrs(panelAnatomy.scope, panelAnatomy.root, { state }),
          {
            'data-aeon-collapsible': collapsible ? 'true' : undefined,
          },
          rest,
        )}
      >
        {children}
      </div>
    </PanelCtx.Provider>
  )
})

/* ------------------------------------------------------------------ */
/*  Trigger                                                            */
/* ------------------------------------------------------------------ */

export interface PanelTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

const Trigger = forwardRef<HTMLButtonElement, PanelTriggerProps>(function PanelTrigger(
  { children, onClick, ...rest },
  ref,
) {
  const { expanded, collapsible, contentId, send, label } = usePanelCtx()

  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={expanded}
      aria-controls={contentId}
      disabled={!collapsible}
      {...mergeProps(
        partAttrs(panelAnatomy.scope, panelAnatomy.trigger, {
          state: expanded ? 'expanded' : 'collapsed',
        }),
        rest,
      )}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented && collapsible) send({ type: 'TOGGLE' })
      }}
    >
      {children ?? (expanded ? 'Collapse' : `Expand ${label}`)}
    </button>
  )
})

/* ------------------------------------------------------------------ */
/*  Label — vertical upright letters when collapsed                    */
/* ------------------------------------------------------------------ */

export interface PanelLabelProps extends HTMLAttributes<HTMLSpanElement> {
  /** Override root label text. */
  children?: ReactNode
}

const Label = forwardRef<HTMLSpanElement, PanelLabelProps>(function PanelLabel(
  { children, onClick, ...rest },
  ref,
) {
  const { label, state, collapsible, send, expanded, contentId } = usePanelCtx()
  const text = typeof children === 'string' || children == null ? String(children ?? label) : null

  return (
    <span
      ref={ref}
      role={collapsible ? 'button' : undefined}
      tabIndex={collapsible ? 0 : undefined}
      aria-expanded={collapsible ? expanded : undefined}
      aria-controls={collapsible ? contentId : undefined}
      {...mergeProps(partAttrs(panelAnatomy.scope, panelAnatomy.label, { state }), rest)}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented && collapsible) send({ type: 'TOGGLE' })
      }}
      onKeyDown={(e) => {
        if (!collapsible) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          send({ type: 'TOGGLE' })
        }
      }}
    >
      {text != null ? (
        state === 'collapsed' ? (
          text.split('').map((ch, i) =>
            ch === ' ' ? (
              <span key={`sp-${i}`} data-aeon-part="label-gap" aria-hidden>
                {' '}
              </span>
            ) : (
              <span key={`${ch}-${i}`} data-aeon-part="label-char">
                {ch}
              </span>
            ),
          )
        ) : (
          text
        )
      ) : (
        children
      )}
    </span>
  )
})

/* ------------------------------------------------------------------ */
/*  Content                                                            */
/* ------------------------------------------------------------------ */

export interface PanelContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Prefer Scroll.Root inside for overflow regions. */
  children?: ReactNode
}

const Content = forwardRef<HTMLDivElement, PanelContentProps>(function PanelContent(
  { children, ...rest },
  ref,
) {
  const { expanded, contentId, state } = usePanelCtx()

  return (
    <div
      ref={ref}
      id={contentId}
      hidden={!expanded}
      {...mergeProps(partAttrs(panelAnatomy.scope, panelAnatomy.content, { state }), rest)}
    >
      {children}
    </div>
  )
})

export const Panel = {
  Group,
  Root,
  Trigger,
  Label,
  Content,
}
