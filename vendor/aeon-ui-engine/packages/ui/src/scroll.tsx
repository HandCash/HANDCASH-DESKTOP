import { Scroll as Headless, useScrollContext } from '@aeon-ui/react'
import { aeonScroll } from '@aeon-ui/panda/styled-system/recipes'
import { createContext, useContext, type ComponentProps } from 'react'
import { cn } from './cn.js'

type Axis = 'y' | 'x' | 'both'
type MaxH = 'sm' | 'md' | 'lg'

type SlotClasses = ReturnType<typeof aeonScroll>

const ScrollStyleCtx = createContext<SlotClasses | null>(null)

function useScrollStyles(): SlotClasses {
  const s = useContext(ScrollStyleCtx)
  if (!s) throw new Error('Scroll parts must be used within <Scroll.Root>')
  return s
}

type RootProps = ComponentProps<typeof Headless.Root> & {
  axis?: Axis
  maxH?: MaxH
}

export const Scroll = {
  Root: ({ className, axis = 'both', maxH = 'md', children, ...props }: RootProps) => {
    const s = aeonScroll({ axis, maxH })
    return (
      <ScrollStyleCtx.Provider value={s}>
        <Headless.Root className={cn(s.root, className)} {...props}>
          {children}
        </Headless.Root>
      </ScrollStyleCtx.Provider>
    )
  },
  Viewport: ({ className, ...props }: ComponentProps<typeof Headless.Viewport>) => {
    const s = useScrollStyles()
    return <Headless.Viewport className={cn(s.viewport, className)} {...props} />
  },
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => {
    const s = useScrollStyles()
    return <Headless.Content className={cn(s.content, className)} {...props} />
  },
  StateReadout: ({ className }: { className?: string }) => {
    const { stateAttr } = useScrollContext()
    return (
      <code className={className} data-aeon-part="state-readout">
        {stateAttr}
      </code>
    )
  },
}
