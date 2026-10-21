import { SegmentGroup as Headless } from '@aeon-ui/react'
import { aeonSegmentGroup } from '@aeon-ui/panda/styled-system/recipes'
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef } from 'react'
import { cn } from './cn.js'

type Size = 'sm' | 'md'

const SizeCtx = createContext<Size>('md')

type RootProps = ComponentPropsWithoutRef<typeof Headless.Root> & { size?: Size }

const Root = forwardRef<HTMLDivElement, RootProps>(function SegmentGroup({ className, size = 'md', ...props }, ref) {
  return (
    <SizeCtx.Provider value={size}>
      <Headless.Root ref={ref} className={cn(aeonSegmentGroup({ size }).root, className)} {...props} />
    </SizeCtx.Provider>
  )
})

const Item = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Headless.Item>>(function SegmentGroupItem(
  { className, ...props },
  ref,
) {
  const size = useContext(SizeCtx)
  return <Headless.Item ref={ref} className={cn(aeonSegmentGroup({ size }).item, className)} {...props} />
})

export const SegmentGroup = { Root, Item }
