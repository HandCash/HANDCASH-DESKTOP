import { fieldAnatomy, fieldFace, fieldRegions, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import { fieldMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface FieldContextValue {
  /** Primary visual face — idle | dirty | invalid | pending (same hierarchy as Button). */
  face: ReturnType<typeof fieldFace>
  /** @deprecated Use `face` — kept as an alias for older callers. */
  stateAttr: string
  interaction: string
  validation: string
  submission: string
  send: ReturnType<typeof useAeonMachine<typeof fieldMachine>>[1]
  invalid: boolean
  pending: boolean
}

const FieldCtx = createContext<FieldContextValue | null>(null)

export function useFieldContext(): FieldContextValue {
  const ctx = useContext(FieldCtx)
  if (!ctx) throw new Error('Field parts must be used within <Field.Root>')
  return ctx
}

export interface FieldRootProps {
  children: ReactNode
  className?: string
  id?: string
}

const Root = forwardRef<HTMLDivElement, FieldRootProps>(function FieldRoot(
  { children, className, id },
  ref,
) {
  const [snapshot, send] = useAeonMachine(fieldMachine)
  const face = fieldFace(snapshot.value)
  const regions = fieldRegions(snapshot.value)
  const invalid = regions.validation === 'invalid'
  const pending = regions.submission === 'pending'

  const value = useMemo(
    () => ({
      face,
      stateAttr: face,
      interaction: regions.interaction,
      validation: regions.validation,
      submission: regions.submission,
      send,
      invalid,
      pending,
    }),
    [face, regions.interaction, regions.validation, regions.submission, send, invalid, pending],
  )

  return (
    <FieldCtx.Provider value={value}>
      <div
        ref={ref}
        id={id}
        className={className}
        data-aeon-interaction={regions.interaction}
        data-aeon-validation={regions.validation}
        data-aeon-submission={regions.submission}
        {...partAttrs(fieldAnatomy.scope, fieldAnatomy.root, { state: face })}
      >
        {children}
      </div>
    </FieldCtx.Provider>
  )
})

const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function FieldLabel(
  props,
  ref,
) {
  return <label ref={ref} {...partOnlyAttrs(fieldAnatomy.label)} {...props} />
})

export interface FieldControlProps extends InputHTMLAttributes<HTMLInputElement> {
  validate?: (value: string) => boolean
}

const Control = forwardRef<HTMLInputElement, FieldControlProps>(function FieldControl(
  { validate, onChange, onBlur, ...rest },
  ref,
) {
  const { send, invalid } = useFieldContext()

  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      {...partOnlyAttrs(fieldAnatomy.control)}
      {...mergeProps(
        {
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            send({ type: 'INPUT' })
            const ok = validate?.(e.target.value) ?? true
            send({ type: 'VALIDATE', valid: ok })
            onChange?.(e)
          },
          onBlur: (e: FocusEvent<HTMLInputElement>) => {
            send({ type: 'BLUR' })
            onBlur?.(e)
          },
        },
        rest,
      )}
    />
  )
})

export interface FieldTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  validate?: (value: string) => boolean
}

const Textarea = forwardRef<HTMLTextAreaElement, FieldTextareaProps>(function FieldTextarea(
  { validate, onChange, onBlur, ...rest },
  ref,
) {
  const { send, invalid } = useFieldContext()

  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      {...partOnlyAttrs(fieldAnatomy.textarea)}
      {...mergeProps(
        {
          onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
            send({ type: 'INPUT' })
            const ok = validate?.(e.target.value) ?? true
            send({ type: 'VALIDATE', valid: ok })
            onChange?.(e)
          },
          onBlur: (e: FocusEvent<HTMLTextAreaElement>) => {
            send({ type: 'BLUR' })
            onBlur?.(e)
          },
        },
        rest,
      )}
    />
  )
})

const Message = forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function FieldMessage({ children, ...props }, ref) {
    const { invalid } = useFieldContext()
    if (!invalid) return null
    return (
      <p
        ref={ref}
        role="alert"
        {...partOnlyAttrs(fieldAnatomy.message, { state: 'invalid' })}
        {...props}
      >
        {children ?? 'Check this field.'}
      </p>
    )
  },
)

const Hint = forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function FieldHint(props, ref) {
    return <p ref={ref} {...partOnlyAttrs(fieldAnatomy.hint)} {...props} />
  },
)

export const Field = { Root, Label, Control, Input: Control, Textarea, Message, Hint }
export { fieldMachine }
