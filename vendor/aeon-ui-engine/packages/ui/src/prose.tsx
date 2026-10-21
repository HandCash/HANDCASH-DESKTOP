import { Prose as Headless } from '@aeon-ui/react'
import { aeonProse } from '@aeon-ui/panda/styled-system/recipes'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { cn } from './cn.js'

const prose = aeonProse()

const Root = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Headless.Root>>(function Prose(
  { className, ...props },
  ref,
) {
  return <Headless.Root ref={ref} className={cn(prose.root, className)} {...props} />
})

export const Prose = { Root }
