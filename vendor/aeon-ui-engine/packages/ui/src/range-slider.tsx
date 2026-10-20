import { RangeSlider as Headless } from '@aeon-ui/react'
import { aeonRangeSlider } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const recipe = aeonRangeSlider()

export const RangeSlider = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(recipe.root, className)} {...props} />
  ),
  Track: ({ className, ...props }: ComponentProps<typeof Headless.Track>) => (
    <Headless.Track className={cn(recipe.track, className)} {...props} />
  ),
  Range: ({ className, ...props }: ComponentProps<typeof Headless.Range>) => (
    <Headless.Range className={cn(recipe.range, className)} {...props} />
  ),
  Thumb: ({ className, ...props }: ComponentProps<typeof Headless.Thumb>) => (
    <Headless.Thumb className={cn(recipe.thumb, className)} {...props} />
  ),
  ValueText: ({ className, ...props }: ComponentProps<typeof Headless.ValueText>) => (
    <Headless.ValueText className={cn(recipe.valueText, className)} {...props} />
  ),
}
