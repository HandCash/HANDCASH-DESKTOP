import { ThemeSwitcher as Headless } from '@aeon-ui/react'
import { aeonThemeSwitcher } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type ThemeSwitcherSize = 'xs' | 'sm' | 'md'

type RootProps = ComponentProps<typeof Headless.Root> & {
  size?: ThemeSwitcherSize
}

type ModesProps = ComponentProps<typeof Headless.Modes>

type ModeBtnProps = ComponentProps<typeof Headless.ModeBtn>

type ThemeSelectProps = ComponentProps<typeof Headless.ThemeSelect>

type ThemeTriggerProps = ComponentProps<typeof Headless.ThemeTrigger>

export const ThemeSwitcher = {
  Root: ({ className, size, ...props }: RootProps) => {
    const styles = aeonThemeSwitcher({ size })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Modes: ({ className, ...props }: ModesProps) => {
    const styles = aeonThemeSwitcher({})
    return <Headless.Modes className={cn(styles.modes, className)} {...props} />
  },
  ModeBtn: ({ className, ...props }: ModeBtnProps) => {
    const styles = aeonThemeSwitcher({})
    return <Headless.ModeBtn className={cn(styles.modeBtn, className)} {...props} />
  },
  ThemeSelect: ({ className, ...props }: ThemeSelectProps) => {
    const styles = aeonThemeSwitcher({})
    return <Headless.ThemeSelect className={cn(styles.themeSelect, className)} {...props} />
  },
  ThemeTrigger: ({ className, ...props }: ThemeTriggerProps) => {
    const styles = aeonThemeSwitcher({})
    return <Headless.ThemeTrigger className={cn(styles.themeTrigger, className)} {...props} />
  },
}
