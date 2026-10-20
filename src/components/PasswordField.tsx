import { Field } from '@aeon-ui/react'
import { useId, useState, type InputHTMLAttributes } from 'react'
import { EyeIcon, EyeOffIcon } from './icons'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
  id?: string
}

/** Password input with show/hide (peek eye) toggle. */
export function PasswordField({ label, id, className, disabled, ...rest }: Props) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const [visible, setVisible] = useState(false)

  return (
    <Field.Root className={`field${className ? ` ${className}` : ''}`}>
      <Field.Label htmlFor={fieldId}>{label}</Field.Label>
      <div className="password-field">
        <Field.Control
          id={fieldId}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          {...rest}
        />
        <button
          type="button"
          className="password-field-toggle"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          tabIndex={-1}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      </div>
    </Field.Root>
  )
}
