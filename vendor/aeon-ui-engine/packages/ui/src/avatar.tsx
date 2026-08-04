import { Avatar as Headless } from '@aeon-ui/react'
import { aeonAvatar } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

type RootProps = ComponentProps<typeof Headless.Root> & {
  size?: AvatarSize
}

export const Avatar = {
  Root: ({ className, size = 'md', ...props }: RootProps) => {
    const styles = aeonAvatar({ size })
    return (
      <Headless.Root
        className={cn(styles.root, className)}
        data-aeon-size={size}
        {...props}
      />
    )
  },
  Image: ({ className, ...props }: ComponentProps<typeof Headless.Image>) => {
    const styles = aeonAvatar()
    return <Headless.Image className={cn(styles.image, className)} {...props} />
  },
  Fallback: ({ className, ...props }: ComponentProps<typeof Headless.Fallback>) => {
    const styles = aeonAvatar()
    return <Headless.Fallback className={cn(styles.fallback, className)} {...props} />
  },
  Badge: ({ className, ...props }: ComponentProps<typeof Headless.Badge>) => {
    const styles = aeonAvatar()
    return <Headless.Badge className={cn(styles.badge, className)} {...props} />
  },
}
