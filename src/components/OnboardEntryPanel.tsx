/**
 * First onboarding screen.
 *
 * Not signed in: Sign in + Create new wallet.
 * Signed in (prior cloud context): single Migrate CTA — Create hidden.
 */

import { Button } from '@aeon-ui/react'
import type { CloudPriorSession } from '../wallet/cloudPriorSession'
import { AuthEntryTaglines } from './auth/AuthEntryTaglines'
import { onboardEntryKind } from './auth/onboardEntry'
import { BrandLogo } from './BrandLogo'

type Props = {
  session: CloudPriorSession | null
  /** Existing wallet — device / email sign-in. */
  onSignIn: () => void
  onCreate: () => void
  onMigrate: () => void
}

export function OnboardEntryPanel({ session, onSignIn, onCreate, onMigrate }: Props) {
  const kind = onboardEntryKind(Boolean(session))
  const handleLabel = session?.handle ? `$${session.handle}` : null

  if (kind === 'signed-in') {
    return (
      <section
        className="auth-screen"
        data-aeon-scope="auth"
        data-aeon-state="onboard-entry-signed-in"
      >
        <div className="auth-entry-brand" data-aeon-part="entry-brand">
          <BrandLogo variant="green" size={48} />
        </div>
        <div className="auth-copy">
          <h1 className="auth-title">Migrate your wallet</h1>
          <p className="auth-lede">
            {handleLabel
              ? `You're signed in as ${handleLabel}. Bring your handle, keys, and holdings into this app.`
              : "You're signed in to HandCash. Bring your handle, keys, and holdings into this app."}
          </p>
        </div>
        <div className="auth-entry-actions" data-aeon-part="entry-actions">
          <Button.Root
            variant="solid"
            className="btn btn-primary auth-entry-primary"
            data-aeon-part="migrate"
            onClick={onMigrate}
          >
            <Button.Label>Migrate</Button.Label>
          </Button.Root>
        </div>
        <AuthEntryTaglines />
      </section>
    )
  }

  return (
    <section
      className="auth-screen"
      data-aeon-scope="auth"
      data-aeon-state="onboard-entry-unsigned"
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
      <AuthEntryTaglines />
    </section>
  )
}
