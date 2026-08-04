import { Entry as Headless } from '@aeon-ui/react'
import { aeonEntry } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type Density = 'compact' | 'cozy'
type Layout = 'stack' | 'split'

type ListProps = ComponentProps<typeof Headless.List> & {
  density?: Density
  layout?: Layout
}
type RootProps = ComponentProps<typeof Headless.Root> & {
  density?: Density
  layout?: Layout
}
type PartProps = ComponentProps<typeof Headless.Title>

export const Entry = {
  List: ({ className, density = 'compact', layout = 'stack', ...props }: ListProps) => {
    const styles = aeonEntry({ density, layout })
    return <Headless.List className={cn(styles.list, className)} {...props} />
  },
  Root: ({ className, density = 'compact', layout = 'stack', ...props }: RootProps) => {
    const styles = aeonEntry({ density, layout })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Header: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Header className={cn(styles.header, className)} {...props} />
  },
  Leading: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Leading className={cn(styles.leading, className)} {...props} />
  },
  Heading: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Heading className={cn(styles.heading, className)} {...props} />
  },
  Title: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Title className={cn(styles.title, className)} {...props} />
  },
  Subtitle: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Subtitle className={cn(styles.subtitle, className)} {...props} />
  },
  Meta: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Meta className={cn(styles.meta, className)} {...props} />
  },
  Media: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Media className={cn(styles.media, className)} {...props} />
  },
  Body: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Body className={cn(styles.body, className)} {...props} />
  },
  Values: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Values className={cn(styles.values, className)} {...props} />
  },
  Value: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Value className={cn(styles.value, className)} {...props} />
  },
  Actions: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Actions className={cn(styles.actions, className)} {...props} />
  },
  Footer: ({ className, ...props }: PartProps) => {
    const styles = aeonEntry()
    return <Headless.Footer className={cn(styles.footer, className)} {...props} />
  },
}
