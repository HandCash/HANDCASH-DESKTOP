import { Switch as Headless } from '@aeon-ui/react'
import { aeonSwitch } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.js'

const switchStyles = aeonSwitch()

type RootProps = ComponentProps<typeof Headless.Root>

export const Switch = {
  Root: ({ className, children, ...props }: RootProps) => {
    const styles = switchStyles
    const body: ReactNode =
      children ?? (
        <Headless.Control className={styles.control}>
          <Headless.Thumb className={styles.thumb} />
        </Headless.Control>
      )
    return (
      <Headless.Root className={cn(styles.root, className)} {...props}>
        {body}
      </Headless.Root>
    )
  },
  Control: ({ className, ...props }: ComponentProps<typeof Headless.Control>) => (
    <Headless.Control className={cn(switchStyles.control, className)} {...props} />
  ),
  Thumb: ({ className, ...props }: ComponentProps<typeof Headless.Thumb>) => (
    <Headless.Thumb className={cn(switchStyles.thumb, className)} {...props} />
  ),
  Label: ({ className, ...props }: ComponentProps<typeof Headless.Label>) => (
    <Headless.Label className={cn(switchStyles.label, className)} {...props} />
  ),
  HiddenInput: Headless.HiddenInput,
}
