/**
 * First onboarding screen for cloud → app migration.
 *
 * Not signed in: Sign in + Create new wallet (two clear choices).
 * Signed in (prior cloud context): single Migrate CTA — Create hidden.
 */

import { Button } from '@aeon-ui/react'
import type { CloudPriorSession } from '../wallet/cloudPriorSession'
import { onboardEntryKind } from './auth/onboardEntry'

type Props = {
  session: CloudPriorSession | null
  /** Cloud HandCash sign-in → migration (not device Connect). */
  onSignIn: () => void
  onCreate: () => void
  onMigrate: () => void
  /** Quieter path: existing vault on another device (device sign-in). */
  onConnectDevice?: () => void
}

export function OnboardEntryPanel({
  session,
  onSignIn,
  onCreate,
  onMigrate,
  onConnectDevice,
}: Props) {
  const kind = onboardEntryKind(Boolean(session))
  const handleLabel = session?.handle ? `$${session.handle}` : null

  if (kind === 'signed-in') {
    return (
      <section
        className="auth-screen"
        data-aeon-scope="auth"
        data-aeon-state="onboard-entry-signed-in"
      >
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
            className="auth-entry-primary"
            data-aeon-part="migrate"
            onClick={onMigrate}
          >
            <Button.Label>Migrate</Button.Label>
          </Button.Root>
        </div>
      </section>
    )
  }

  return (
    <section
      className="auth-screen"
      data-aeon-scope="auth"
      data-aeon-state="onboard-entry-unsigned"
    >
      <div className="auth-copy">
        <h1 className="auth-title">HandCash</h1>
        <p className="auth-lede">
          Sign in to bring an existing HandCash account into this app, or create a new wallet on
          this device.
        </p>
      </div>
      <div className="auth-entry-actions" data-aeon-part="entry-actions">
        <Button.Root
          variant="solid"
          className="auth-entry-primary"
          data-aeon-part="sign-in"
          onClick={onSignIn}
        >
          <Button.Label>Sign in</Button.Label>
        </Button.Root>
        <Button.Root
          variant="outline"
          className="auth-entry-secondary"
          data-aeon-part="create"
          onClick={onCreate}
        >
          <Button.Label>Create new wallet</Button.Label>
        </Button.Root>
      </div>
      {onConnectDevice ? (
        <p className="auth-alt">
          Already have this wallet on another device?{' '}
          <button type="button" className="auth-alt-link" onClick={onConnectDevice}>
            Connect device
          </button>
        </p>
      ) : null}
    </section>
  )
}
