import { appShellAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { appShellMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

type AppShellChrome = 'idle' | 'overlayOpen'

interface AppShellContextValue {
  chrome: AppShellChrome
  dockVisible: boolean
  overlayOpen: boolean
  send: ReturnType<typeof useAeonMachine<typeof appShellMachine>>[1]
}

const AppShellCtx = createContext<AppShellContextValue | null>(null)

export function useAppShellContext() {
  const ctx = useContext(AppShellCtx)
  if (!ctx) throw new Error('AppShell parts must be used within AppShell.Root')
  return ctx
}

export interface AppShellRootProps extends HTMLAttributes<HTMLDivElement> {
  /** Initial dock visibility when uncontrolled. */
  defaultDockVisible?: boolean
  /** Controlled dock visibility — syncs into the shell machine. */
  dockVisible?: boolean
  children?: ReactNode
}

const Root = forwardRef<HTMLDivElement, AppShellRootProps>(function AppShellRoot(
  { defaultDockVisible = true, dockVisible: dockVisibleProp, children, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(appShellMachine, {
    input: { dockVisible: dockVisibleProp ?? defaultDockVisible },
  })
  const chrome = snapshot.value as AppShellChrome
  const dockVisible = dockVisibleProp ?? snapshot.context.dockVisible

  useEffect(() => {
    if (dockVisibleProp === undefined) return
    if (snapshot.context.dockVisible !== dockVisibleProp) {
      send({ type: 'SET_DOCK', visible: dockVisibleProp })
    }
  }, [dockVisibleProp, snapshot.context.dockVisible, send])

  const value = useMemo(
    () => ({
      chrome,
      dockVisible,
      overlayOpen: chrome === 'overlayOpen',
      send,
    }),
    [chrome, dockVisible, send],
  )

  return (
    <AppShellCtx.Provider value={value}>
      <div
        ref={ref}
        data-aeon-dock={dockVisible ? 'visible' : 'hidden'}
        {...mergeProps(
          scopeAttrs(appShellAnatomy.scope, appShellAnatomy.root, { state: chrome }),
          rest,
        )}
      >
        {children}
      </div>
    </AppShellCtx.Provider>
  )
})

function ShellPart(
  part: string,
  displayName: string,
  defaultTag: 'div' | 'header' | 'footer' | 'aside' | 'main' = 'div',
) {
  const Comp = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { as?: typeof defaultTag }>(
    function AeonShellPart({ as: Tag = defaultTag, ...rest }, ref) {
      const { chrome } = useAppShellContext()
      return (
        <Tag
          ref={ref as never}
          {...mergeProps(partAttrs(appShellAnatomy.scope, part, { state: chrome }), rest)}
        />
      )
    },
  )
  Comp.displayName = displayName
  return Comp
}

const Header = ShellPart(appShellAnatomy.header, 'AppShell.Header', 'header')
const Subheader = ShellPart(appShellAnatomy.subheader, 'AppShell.Subheader')
const Content = ShellPart(appShellAnatomy.content, 'AppShell.Content', 'main')
const Aside = ShellPart(appShellAnatomy.aside, 'AppShell.Aside', 'aside')
const Footer = ShellPart(appShellAnatomy.footer, 'AppShell.Footer', 'footer')

const Dock = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AppShellDock(
  { hidden, ...rest },
  ref,
) {
  const { chrome, dockVisible } = useAppShellContext()
  if (!dockVisible) return null
  return (
    <div
      ref={ref}
      hidden={hidden}
      {...mergeProps(partAttrs(appShellAnatomy.scope, appShellAnatomy.dock, { state: chrome }), rest)}
    />
  )
})

const Scrim = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AppShellScrim(
  props,
  ref,
) {
  const { chrome, overlayOpen, send } = useAppShellContext()
  if (!overlayOpen) return null
  return (
    <div
      ref={ref}
      role="presentation"
      onClick={() => send({ type: 'CLOSE_OVERLAY' })}
      {...mergeProps(partAttrs(appShellAnatomy.scope, appShellAnatomy.scrim, { state: chrome }), props)}
    />
  )
})

/**
 * AppShell — application chrome frame.
 * Machine: idle | overlayOpen (+ dockVisible context).
 * UI = f(snapshot): content dims / scrim when overlayOpen; dock hides when dockVisible=false.
 */
export const AppShell = {
  Root,
  Header,
  Subheader,
  Content,
  Aside,
  Footer,
  Dock,
  Scrim,
}
