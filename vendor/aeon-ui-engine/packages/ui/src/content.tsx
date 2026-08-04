import { Content as Headless } from '@aeon-ui/react'
import { aeonContent } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type Align = 'start' | 'center'
type RootProps = ComponentProps<typeof Headless.Root> & { align?: Align }
type PartProps = ComponentProps<typeof Headless.Body>

export const Content = {
  Root: ({ className, align = 'start', ...props }: RootProps) => {
    const styles = aeonContent({ align })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Toolbar: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Toolbar className={cn(styles.toolbar, className)} {...props} />
  },
  Body: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Body className={cn(styles.body, className)} {...props} />
  },
  Pending: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Pending className={cn(styles.pending, className)} {...props} />
  },
  Empty: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Empty className={cn(styles.empty, className)} {...props} />
  },
  Error: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Error className={cn(styles.error, className)} {...props} />
  },
  Success: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Success className={cn(styles.success, className)} {...props} />
  },
  Sentinel: ({ className, ...props }: PartProps) => {
    const styles = aeonContent()
    return <Headless.Sentinel className={cn(styles.sentinel, className)} {...props} />
  },
}
