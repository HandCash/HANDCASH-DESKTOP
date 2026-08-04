import { StickyBar as Headless } from '@aeon-ui/react'
import { aeonBar } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type BarSize = 'xs' | 'sm' | 'md' | 'lg'
type Placement = 'top' | 'bottom' | 'inline'

type RootProps = ComponentProps<typeof Headless.Root> & {
  size?: BarSize
  placement?: Placement
}
type ZoneProps = ComponentProps<typeof Headless.Leading>

export const StickyBar = {
  Root: ({ className, size, placement = 'top', ...props }: RootProps) => {
    const styles = aeonBar({ size, placement })
    return (
      <Headless.Root
        className={cn(styles.root, className)}
        placement={placement}
        {...props}
      />
    )
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
  Seam: ({ className, ...props }: ZoneProps) => {
    const styles = aeonBar({})
    return <Headless.Seam className={cn(styles.seam, className)} {...props} />
  },
}
