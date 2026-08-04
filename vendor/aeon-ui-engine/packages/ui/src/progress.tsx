import { Progress as Headless } from '@aeon-ui/react'
import { aeonProgress } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const progress = aeonProgress()

export const Progress = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(progress.root, className)} {...props} />
  ),
  Track: ({ className, ...props }: ComponentProps<typeof Headless.Track>) => (
    <Headless.Track className={cn(progress.track, className)} {...props} />
  ),
  Range: ({ className, ...props }: ComponentProps<typeof Headless.Range>) => (
    <Headless.Range className={cn(progress.range, className)} {...props} />
  ),
  Label: ({ className, ...props }: ComponentProps<typeof Headless.Label>) => (
    <Headless.Label className={cn(progress.label, className)} {...props} />
  ),
}
