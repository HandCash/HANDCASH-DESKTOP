import { Separator as Headless } from '@aeon-ui/react'
import { aeonSeparator } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentProps<typeof Headless.Root> & {
  orientation?: 'horizontal' | 'vertical'
}

export const Separator = {
  Root: ({ className, orientation = 'horizontal', ...props }: RootProps) => {
    const styles = aeonSeparator({ orientation })
    return <Headless.Root className={cn(styles.root, className)} orientation={orientation} {...props} />
  },
}
