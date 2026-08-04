import { Async as Headless, useAsyncContext } from '@aeon-ui/react'
import { aeonAsync } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const styles = () => aeonAsync()

type RootProps = ComponentProps<typeof Headless.Root>
type TrackProps = ComponentProps<typeof Headless.Track>
type ReadoutProps = ComponentProps<typeof Headless.Readout>
type ActionsProps = ComponentProps<typeof Headless.Actions>

export const Async = {
  Root: ({ className, ...props }: RootProps) => {
    const s = styles()
    return <Headless.Root className={cn(s.root, className)} {...props} />
  },
  /** Totality / diagram rail — prefer Content faces in product Instant UIs. */
  Track: ({ className, ...props }: TrackProps) => {
    const s = styles()
    return <Headless.Track className={cn(s.track, 'state-track', className)} {...props} />
  },
  Readout: ({ className, children, ...props }: ReadoutProps) => {
    const s = styles()
    const { status } = useAsyncContext()
    const tone = ['idle', 'loading', 'success', 'failure', 'empty'].includes(status)
      ? status
      : 'idle'
    return (
      <Headless.Readout
        className={cn(s.readout, 'live-status', `live-status--${tone}`, className)}
        {...props}
      >
        {children}
      </Headless.Readout>
    )
  },
  Actions: ({ className, ...props }: ActionsProps) => {
    const s = styles()
    return <Headless.Actions className={cn(s.actions, className)} {...props} />
  },
  Provider: Headless.Provider,
  useContext: useAsyncContext,
}
