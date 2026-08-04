import type { toggleMachine } from '@aeon-ui/primitives'
import type { useAeonMachine } from './hooks/use-aeon-machine.js'

export type SwitchContext = {
  checked: boolean
  disabled: boolean
  controlled: boolean
  onCheckedChange?: (checked: boolean) => void
  send: ReturnType<typeof useAeonMachine<typeof toggleMachine>>['send']
  pressState: string
}

export const SWITCH_CTX = Symbol('aeon-switch')
