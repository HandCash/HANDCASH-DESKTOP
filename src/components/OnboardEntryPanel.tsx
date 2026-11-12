/**
 * First onboarding screen: sign in to a wallet, create one, or recover an old
 * HandCash wallet. Recovery arms the migration checkpoint; the old account's
 * keys only arrive through the encrypted export import, never a kept login.
 */

import { Button } from '@aeon-ui/react'
import { AuthEntryTaglines } from './auth/AuthEntryTaglines'
import { BrandLogo } from './BrandLogo'

type Props = {
  /** Existing wallet — device / email sign-in. */
  onSignIn: () => void
  onCreate: () => void
  onMigrate: () => void
}

export function OnboardEntryPanel({ onSignIn, onCreate, onMigrate }: Props) {
  return (
    <section
      className="auth-screen"
      data-aeon-scope="auth"
      data-aeon-state="onboard-entry"
    >
      <div className="auth-entry-brand" data-aeon-part="entry-brand">
        <BrandLogo variant="green" size={48} />
      </div>
      <div className="auth-entry-actions" data-aeon-part="entry-actions">
        <Button.Root
          variant="solid"
          className="btn btn-primary auth-entry-primary"
          data-aeon-part="sign-in"
          onClick={onSignIn}
        >
          <Button.Label>Sign in</Button.Label>
        </Button.Root>
        <Button.Root
          variant="ghost"
          className="btn btn-ghost auth-entry-secondary"
          data-aeon-part="create"
          onClick={onCreate}
        >
          <Button.Label>Create new wallet</Button.Label>
        </Button.Root>
      </div>
      <p className="auth-alt">
        <Button.Root variant="ghost" className="auth-alt-link" data-aeon-part="migrate" onClick={onMigrate}>
          <Button.Label>Recover an old HandCash wallet</Button.Label>
        </Button.Root>
      </p>
      <AuthEntryTaglines />
    </section>
  )
}
