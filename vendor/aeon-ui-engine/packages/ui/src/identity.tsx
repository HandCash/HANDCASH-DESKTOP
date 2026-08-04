import { Identity as Headless } from '@aeon-ui/react'
import { aeonIdentity } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type Size = 'sm' | 'md' | 'lg'
type RootProps = ComponentProps<typeof Headless.Root> & { size?: Size }
type PartProps = ComponentProps<typeof Headless.Title>

export const Identity = {
  Root: ({ className, size = 'md', ...props }: RootProps) => {
    const styles = aeonIdentity({ size })
    return <Headless.Root className={cn(styles.root, className)} size={size} {...props} />
  },
  Avatar: ({ className, ...props }: PartProps) => {
    const styles = aeonIdentity({})
    return <Headless.Avatar className={cn(styles.avatar, className)} {...props} />
  },
  Title: ({ className, ...props }: PartProps) => {
    const styles = aeonIdentity({})
    return <Headless.Title className={cn(styles.title, className)} {...props} />
  },
  Subtitle: ({ className, ...props }: PartProps) => {
    const styles = aeonIdentity({})
    return <Headless.Subtitle className={cn(styles.subtitle, className)} {...props} />
  },
  Meta: ({ className, ...props }: PartProps) => {
    const styles = aeonIdentity({})
    return <Headless.Meta className={cn(styles.meta, className)} {...props} />
  },
  Trailing: ({ className, ...props }: PartProps) => {
    const styles = aeonIdentity({})
    return <Headless.Trailing className={cn(styles.trailing, className)} {...props} />
  },
}
