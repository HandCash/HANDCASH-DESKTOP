import type { ReactNode } from 'react'
import { AuthEntryField } from './auth/AuthEntryField'

type Props = {
  children: ReactNode
  /** Optional chart / phase projection for the shell. */
  state?: string
}

/**
 * Full-stage signup / unlock frame: five parallax mesh grids (entryMesh chart)
 * behind the form, projected with Aeon scope/parts (no Tailwind).
 */
export function AuthShell({ children, state }: Props) {
  return (
    <div
      className="auth-shell"
      data-aeon-scope="auth-shell"
      data-aeon-state={state || undefined}
    >
      <div className="auth-shell-mesh" data-aeon-part="backdrop" aria-hidden>
        <AuthEntryField />
      </div>
      <div className="auth-shell-scrim" data-aeon-part="scrim" aria-hidden />
      <div className="auth-shell-content" data-aeon-part="content">
        {children}
      </div>
    </div>
  )
}
