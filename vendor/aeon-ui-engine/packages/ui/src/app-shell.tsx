import { AppShell as Headless } from '@aeon-ui/react'
import { aeonAppShell } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type ContentAlign = 'start' | 'center'
type RootProps = ComponentProps<typeof Headless.Root>
type PartProps = ComponentProps<typeof Headless.Content>
type ContentProps = PartProps & { contentAlign?: ContentAlign }

export const AppShell = {
  Root: ({ className, ...props }: RootProps) => {
    const styles = aeonAppShell()
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Header: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Header className={cn(styles.header, className)} {...props} />
  },
  Subheader: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Subheader className={cn(styles.subheader, className)} {...props} />
  },
  Content: ({ className, contentAlign = 'start', ...props }: ContentProps) => {
    const styles = aeonAppShell({ contentAlign })
    return <Headless.Content className={cn(styles.content, className)} {...props} />
  },
  Aside: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Aside className={cn(styles.aside, className)} {...props} />
  },
  Footer: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Footer className={cn(styles.footer, className)} {...props} />
  },
  Dock: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Dock className={cn(styles.dock, className)} {...props} />
  },
  Scrim: ({ className, ...props }: PartProps) => {
    const styles = aeonAppShell()
    return <Headless.Scrim className={cn(styles.scrim, className)} {...props} />
  },
}
