import { Slider as Headless } from '@aeon-ui/react'
import { aeonSlider } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const slider = aeonSlider()

export const Slider = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(slider.root, className)} {...props} />
  ),
  Track: ({ className, ...props }: ComponentProps<typeof Headless.Track>) => (
    <Headless.Track className={cn(slider.track, className)} {...props} />
  ),
  Range: ({ className, ...props }: ComponentProps<typeof Headless.Range>) => (
    <Headless.Range className={cn(slider.range, className)} {...props} />
  ),
  Thumb: ({ className, ...props }: ComponentProps<typeof Headless.Thumb>) => (
    <Headless.Thumb className={cn(slider.thumb, className)} {...props} />
  ),
  ValueText: ({ className, ...props }: ComponentProps<typeof Headless.ValueText>) => (
    <Headless.ValueText className={cn(slider.valueText, className)} {...props} />
  ),
}
