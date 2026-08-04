import {
  appNavAnatomy,
  partAttrs,
  scopeAttrs,
} from '@aeon-ui/core'
import {
  appNavChild,
  appNavMachine,
  appNavStateAttr,
  type AppNavChild,
  type AppNavContext,
} from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

export type { AppNavChild, AppNavContext }

interface AppNavContextValue {
  section: string
  stack: AppNavChild[]
  child: AppNavChild | null
  stateAttr: string
  send: ReturnType<typeof useAeonMachine<typeof appNavMachine>>[1]
  setSection: (section: string) => void
  push: (child: AppNavChild) => void
  replace: (child: AppNavChild) => void
  pop: () => void
  popTo: (id: string) => void
  clear: () => void
}

const AppNavCtx = createContext<AppNavContextValue | null>(null)

export function useAppNav() {
  const ctx = useContext(AppNavCtx)
  if (!ctx) throw new Error('AppNav parts must be used within AppNav.Root')
  return ctx
}

/** Use the machine without the compound tree. */
export function useAppNavMachine(input?: { section?: string; stack?: AppNavChild[] }) {
  const [snapshot, send] = useAeonMachine(appNavMachine, {
    input: { section: input?.section ?? 'home', stack: input?.stack ?? [] },
  })
  const section = snapshot.context.section
  const stack = snapshot.context.stack
  const child = appNavChild(snapshot.context)
  const stateAttr = appNavStateAttr(snapshot.context)

  return useMemo(
    () => ({
      section,
      stack,
      child,
      stateAttr,
      send,
      setSection: (next: string) => send({ type: 'SET_SECTION', section: next }),
      push: (next: AppNavChild) => send({ type: 'PUSH', child: next }),
      replace: (next: AppNavChild) => send({ type: 'REPLACE', child: next }),
      pop: () => send({ type: 'POP' }),
      popTo: (id: string) => send({ type: 'POP_TO', id }),
      clear: () => send({ type: 'CLEAR' }),
      reset: (next: string) => send({ type: 'RESET', section: next }),
    }),
    [section, stack, child, stateAttr, send],
  )
}

export interface AppNavRootProps extends HTMLAttributes<HTMLDivElement> {
  defaultSection?: string
  children?: ReactNode
}

const Root = forwardRef<HTMLDivElement, AppNavRootProps>(function AppNavRoot(
  { defaultSection = 'home', children, ...rest },
  ref,
) {
  const nav = useAppNavMachine({ section: defaultSection })

  return (
    <AppNavCtx.Provider value={nav}>
      <div
        ref={ref}
        {...mergeProps(
          scopeAttrs(appNavAnatomy.scope, appNavAnatomy.root, { state: nav.stateAttr }),
          rest,
        )}
      >
        {children}
      </div>
    </AppNavCtx.Provider>
  )
})

const Rail = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function AppNavRail(props, ref) {
  const { stateAttr } = useAppNav()
  return (
    <nav
      ref={ref as never}
      {...mergeProps(partAttrs(appNavAnatomy.scope, appNavAnatomy.rail, { state: stateAttr }), props)}
    />
  )
})

export interface AppNavSectionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

const Section = forwardRef<HTMLButtonElement, AppNavSectionProps>(function AppNavSection(
  { value, onClick, ...rest },
  ref,
) {
  const { section, child, setSection } = useAppNav()
  const isActive = section === value && !child

  return (
    <button
      ref={ref}
      type="button"
      aria-current={isActive ? 'page' : undefined}
      data-aeon-value={value}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        setSection(value)
      }}
      {...mergeProps(
        partAttrs(appNavAnatomy.scope, appNavAnatomy.section, {
          state: section === value ? (child ? 'section-active' : 'active') : 'inactive',
        }),
        rest,
      )}
    />
  )
})

const Stage = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AppNavStage(
  props,
  ref,
) {
  const { stateAttr } = useAppNav()
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(appNavAnatomy.scope, appNavAnatomy.stage, { state: stateAttr }), props)}
    />
  )
})

export interface AppNavBreadcrumbProps extends HTMLAttributes<HTMLElement> {
  /** Labels for section + each stack entry (length = 1 + stack.length). */
  labels?: string[]
}

const Breadcrumb = forwardRef<HTMLElement, AppNavBreadcrumbProps>(function AppNavBreadcrumb(
  { labels, ...rest },
  ref,
) {
  const { section, stack, setSection, popTo, clear, stateAttr } = useAppNav()
  const crumbs = [
    { id: section, label: labels?.[0] ?? section, kind: 'section' as const },
    ...stack.map((entry, i) => ({
      id: entry.id,
      label: labels?.[i + 1] ?? entry.type,
      kind: 'child' as const,
    })),
  ]

  return (
    <nav
      ref={ref as never}
      aria-label="Breadcrumb"
      {...mergeProps(
        partAttrs(appNavAnatomy.scope, appNavAnatomy.breadcrumb, { state: stateAttr }),
        rest,
      )}
    >
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1
        return (
          <button
            key={`${crumb.kind}:${crumb.id}`}
            type="button"
            disabled={last}
            {...partAttrs(appNavAnatomy.scope, appNavAnatomy.crumb, {
              state: last ? 'current' : 'ancestor',
            })}
            onClick={() => {
              if (crumb.kind === 'section') {
                clear()
                setSection(crumb.id)
              } else {
                popTo(crumb.id)
              }
            }}
          >
            {crumb.label}
          </button>
        )
      })}
    </nav>
  )
})

const Back = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function AppNavBack({ onClick, children = 'Back', ...rest }, ref) {
    const { child, pop, stateAttr } = useAppNav()
    if (!child) return null
    return (
      <button
        ref={ref}
        type="button"
        onClick={(e) => {
          onClick?.(e)
          if (e.defaultPrevented) return
          pop()
        }}
        {...mergeProps(
          partAttrs(appNavAnatomy.scope, appNavAnatomy.back, { state: stateAttr }),
          rest,
        )}
      >
        {children}
      </button>
    )
  },
)

/**
 * AppNav — section rail + detail stack.
 * Machine: SET_SECTION / PUSH / POP / CLEAR. UI = f(section, stack).
 */
export const AppNav = {
  Root,
  Rail,
  Section,
  Stage,
  Breadcrumb,
  Back,
}
