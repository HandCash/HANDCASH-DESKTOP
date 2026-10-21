import { Textarea as Headless } from '@aeon-ui/react'
import { aeonTextarea } from '@aeon-ui/panda/styled-system/recipes'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentPropsWithoutRef<typeof Headless.Root> & {
  variant?: 'outline' | 'ghost'
}

const Root = forwardRef<HTMLTextAreaElement, RootProps>(function Textarea(
  { className, variant = 'outline', ...props },
  ref,
) {
  return <Headless.Root ref={ref} className={cn(aeonTextarea({ variant }).root, className)} {...props} />
})

export const Textarea = { Root }
