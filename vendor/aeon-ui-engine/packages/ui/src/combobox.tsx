import { Combobox as Headless } from '@aeon-ui/react'
import { aeonCombobox } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const styles = () => aeonCombobox()

export const Combobox = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => {
    const s = styles()
    return <Headless.Root className={cn(s.root, className)} {...props} />
  },
  Input: ({ className, ...props }: ComponentProps<typeof Headless.Input>) => {
    const s = styles()
    return <Headless.Input className={cn(s.input, className)} {...props} />
  },
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => {
    const s = styles()
    return <Headless.Content className={cn(s.content, className)} {...props} />
  },
  Item: ({ className, ...props }: ComponentProps<typeof Headless.Item>) => {
    const s = styles()
    return <Headless.Item className={cn(s.item, className)} {...props} />
  },
  Empty: ({ className, ...props }: ComponentProps<typeof Headless.Empty>) => {
    const s = styles()
    return <Headless.Empty className={cn(s.empty, className)} {...props} />
  },
}
