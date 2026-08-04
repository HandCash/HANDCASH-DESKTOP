import { MetricStrip as Headless } from '@aeon-ui/react'
import { aeonMetricStrip } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type Density = 'cluster' | 'loose'
type RootProps = ComponentProps<typeof Headless.Root> & { density?: Density }
type PartProps = ComponentProps<typeof Headless.Chip>

export const MetricStrip = {
  Root: ({ className, density = 'cluster', ...props }: RootProps) => {
    const styles = aeonMetricStrip({ density })
    return (
      <Headless.Root className={cn(styles.root, className)} density={density} {...props} />
    )
  },
  Chip: ({ className, ...props }: PartProps) => {
    const styles = aeonMetricStrip({})
    return <Headless.Chip className={cn(styles.chip, className)} {...props} />
  },
  Value: ({ className, ...props }: PartProps) => {
    const styles = aeonMetricStrip({})
    return <Headless.Value className={cn(styles.value, className)} {...props} />
  },
  Label: ({ className, ...props }: PartProps) => {
    const styles = aeonMetricStrip({})
    return <Headless.Label className={cn(styles.label, className)} {...props} />
  },
}
