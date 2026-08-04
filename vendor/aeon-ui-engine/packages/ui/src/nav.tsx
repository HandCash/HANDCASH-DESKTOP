import { Nav as Headless } from '@aeon-ui/react'
import { aeonNav } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type NavSize = 'sm' | 'md' | 'lg'
type NavLayout = 'inline' | 'dock'
type RootProps = ComponentProps<typeof Headless.Root> & {
  size?: NavSize
  layout?: NavLayout
}
type ItemProps = ComponentProps<typeof Headless.Item>
type PartProps = ComponentProps<typeof Headless.Label>

export const Nav = {
  Root: ({ className, size, layout = 'inline', ...props }: RootProps) => {
    const styles = aeonNav({ size, layout })
    return (
      <Headless.Root
        className={cn(styles.root, className)}
        data-aeon-layout={layout}
        {...props}
      />
    )
  },
  Item: ({ className, ...props }: ItemProps) => {
    const styles = aeonNav({})
    return <Headless.Item className={cn(styles.item, className)} {...props} />
  },
  Indicator: ({ className, ...props }: PartProps) => {
    const styles = aeonNav({})
    return <Headless.Indicator className={cn(styles.indicator, className)} {...props} />
  },
  Label: ({ className, ...props }: PartProps) => {
    const styles = aeonNav({})
    return <Headless.Label className={cn(styles.label, className)} {...props} />
  },
  Icon: ({ className, ...props }: PartProps) => {
    const styles = aeonNav({})
    return <Headless.Icon className={cn(styles.icon, className)} {...props} />
  },
  Badge: ({ className, ...props }: PartProps) => {
    const styles = aeonNav({})
    return <Headless.Badge className={cn(styles.badge, className)} {...props} />
  },
}
