import { ListRow as Headless } from '@aeon-ui/react'
import { aeonListRow } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentProps<typeof Headless.Root>
type PartProps = ComponentProps<typeof Headless.Label>

export const ListRow = {
  Root: ({ className, ...props }: RootProps) => {
    const styles = aeonListRow()
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Leading: ({ className, ...props }: PartProps) => {
    const styles = aeonListRow()
    return <Headless.Leading className={cn(styles.leading, className)} {...props} />
  },
  Label: ({ className, ...props }: PartProps) => {
    const styles = aeonListRow()
    return <Headless.Label className={cn(styles.label, className)} {...props} />
  },
  Description: ({ className, ...props }: PartProps) => {
    const styles = aeonListRow()
    return <Headless.Description className={cn(styles.description, className)} {...props} />
  },
  Trailing: ({ className, ...props }: PartProps) => {
    const styles = aeonListRow()
    return <Headless.Trailing className={cn(styles.trailing, className)} {...props} />
  },
}
