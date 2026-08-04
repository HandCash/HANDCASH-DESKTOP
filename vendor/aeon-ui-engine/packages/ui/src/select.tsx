import { Select as Headless } from '@aeon-ui/react'
import { aeonSelect } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const styles = () => aeonSelect()

export const Select = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => {
    const s = styles()
    return <Headless.Root className={cn(s.root, className)} {...props} />
  },
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => {
    const s = styles()
    return <Headless.Trigger className={cn(s.trigger, className)} {...props} />
  },
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => {
    const s = styles()
    return <Headless.Content className={cn(s.content, className)} {...props} />
  },
  ValueText: ({ className, ...props }: ComponentProps<typeof Headless.ValueText>) => {
    const s = styles()
    return <Headless.ValueText className={cn(s.value, className)} {...props} />
  },
  Positioner: ({ className, ...props }: ComponentProps<typeof Headless.Positioner>) => (
    <Headless.Positioner className={className} {...props} />
  ),
  Item: ({ className, ...props }: ComponentProps<typeof Headless.Item>) => {
    const s = styles()
    return <Headless.Item className={cn(s.item, className)} {...props} />
  },
}
