import { PinInput as Headless } from '@aeon-ui/react'
import { aeonPinInput } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const pinInput = aeonPinInput()

export const PinInput = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(pinInput.root, className)} {...props} />
  ),
  Input: ({ className, ...props }: ComponentProps<typeof Headless.Input>) => (
    <Headless.Input className={cn(pinInput.input, className)} {...props} />
  ),
  Group: Headless.Group,
}
