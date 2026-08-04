import { RadioGroup as Headless } from '@aeon-ui/react'
import { aeonRadioGroup } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const radioGroup = aeonRadioGroup()

export const RadioGroup = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(radioGroup.root, className)} {...props} />
  ),
  Item: ({ className, ...props }: ComponentProps<typeof Headless.Item>) => (
    <Headless.Item className={cn(radioGroup.item, className)} {...props} />
  ),
  ItemControl: ({ className, ...props }: ComponentProps<typeof Headless.ItemControl>) => (
    <Headless.ItemControl className={cn(radioGroup.itemControl, className)} {...props} />
  ),
  ItemIndicator: ({ className, ...props }: ComponentProps<typeof Headless.ItemIndicator>) => (
    <Headless.ItemIndicator className={cn(radioGroup.itemIndicator, className)} {...props} />
  ),
  ItemLabel: ({ className, ...props }: ComponentProps<typeof Headless.ItemLabel>) => (
    <Headless.ItemLabel className={cn(radioGroup.itemLabel, className)} {...props} />
  ),
}
