import { Bar as Headless } from '@aeon-ui/react'
import { aeonBar } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type BarSize = 'xs' | 'sm' | 'md' | 'lg'
type BarCollapse = 'shrink' | 'wrap' | 'collapse-center'

type RootProps = ComponentProps<typeof Headless.Root> & {
  size?: BarSize
  sticky?: boolean
  collapse?: BarCollapse
}

type ZoneProps = ComponentProps<typeof Headless.Leading>

export const Bar = {
  Root: ({ className, size, sticky, collapse, ...props }: RootProps) => {
    const styles = aeonBar({ size, sticky, collapse })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Leading: ({ className, ...props }: ZoneProps) => {
    const styles = aeonBar({})
    return <Headless.Leading className={cn(styles.leading, className)} {...props} />
  },
  Center: ({ className, ...props }: ZoneProps) => {
    const styles = aeonBar({})
    return <Headless.Center className={cn(styles.center, className)} {...props} />
  },
  Trailing: ({ className, ...props }: ZoneProps) => {
    const styles = aeonBar({})
    return <Headless.Trailing className={cn(styles.trailing, className)} {...props} />
  },
}
