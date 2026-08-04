import { ProfileHeader as Headless } from '@aeon-ui/react'
import { aeonProfileHeader } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type Align = 'start' | 'center'
type RootProps = ComponentProps<typeof Headless.Root> & { align?: Align }
type PartProps = ComponentProps<typeof Headless.Body>

export const ProfileHeader = {
  Root: ({ className, align = 'start', ...props }: RootProps) => {
    const styles = aeonProfileHeader({ align })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Media: ({ className, ...props }: PartProps) => {
    const styles = aeonProfileHeader()
    return <Headless.Media className={cn(styles.media, className)} {...props} />
  },
  Identity: ({ className, ...props }: PartProps) => {
    const styles = aeonProfileHeader()
    return <Headless.Identity className={cn(styles.identity, className)} {...props} />
  },
  Metrics: ({ className, ...props }: PartProps) => {
    const styles = aeonProfileHeader()
    return <Headless.Metrics className={cn(styles.metrics, className)} {...props} />
  },
  Actions: ({ className, ...props }: PartProps) => {
    const styles = aeonProfileHeader()
    return <Headless.Actions className={cn(styles.actions, className)} {...props} />
  },
  Body: ({ className, ...props }: PartProps) => {
    const styles = aeonProfileHeader()
    return <Headless.Body className={cn(styles.body, className)} {...props} />
  },
}
