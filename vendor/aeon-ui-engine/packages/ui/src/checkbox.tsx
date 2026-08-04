import { Checkbox as Headless } from '@aeon-ui/react'
import { aeonCheckbox } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const checkbox = aeonCheckbox()

export const Checkbox = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(checkbox.root, className)} {...props} />
  ),
  Control: ({ className, ...props }: ComponentProps<typeof Headless.Control>) => (
    <Headless.Control className={cn(checkbox.control, className)} {...props} />
  ),
  Indicator: ({ className, children, ...props }: ComponentProps<typeof Headless.Indicator>) => (
    <Headless.Indicator className={cn(checkbox.indicator, className)} {...props}>
      {children ?? '✓'}
    </Headless.Indicator>
  ),
  Label: ({ className, ...props }: ComponentProps<typeof Headless.Label>) => (
    <Headless.Label className={cn(checkbox.label, className)} {...props} />
  ),
  HiddenInput: Headless.HiddenInput,
}
