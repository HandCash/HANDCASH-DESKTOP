import { Button } from '@aeon-ui/react'
import type { PendingAction, PermissionLifetime } from '../wallet/permissions'
/** Choice state belongs to permissionDecisionMachine; this only projects it. */
export function PermissionLifetimeControls({ pending, lifetime, disabled, onChange }: {
  pending: PendingAction; lifetime: PermissionLifetime; disabled: boolean; onChange: (value: PermissionLifetime) => void
}) {
  if (!pending.featureAccess) return null
  const effectiveLifetime = pending.featureAccess.singleRequest ? 'once' : lifetime
  const choices: PermissionLifetime[] = pending.featureAccess.singleRequest ? ['once'] : pending.featureAccess.grouped ? ['session', 'remember'] : ['once', 'session', 'remember']
  return <section data-aeon-scope="permission-lifetime" data-aeon-state={effectiveLifetime}>
    <ul>{pending.featureAccess.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul>
    <p>Payment methods still require their own approval. These permissions cover the listed features and do not establish trust in an opponent.</p>
    <div role="group" aria-label="Access duration">{choices.map(choice => <Button.Root key={choice} variant={choice === effectiveLifetime ? 'solid' : 'ghost'} aria-pressed={choice === effectiveLifetime} disabled={disabled} onClick={() => onChange(choice)}>
      {choice === 'once' ? 'Allow once' : choice === 'session' ? 'This session · up to 30 minutes' : 'Remember'}
    </Button.Root>)}</div>
    <p>{effectiveLifetime === 'once' ? 'This request only. No session or permission token is created.' : effectiveLifetime === 'remember' ? 'Creates on-chain permission tokens. Transaction and wallet service fees may apply. Revoke in Connected apps → Wallet feature access.' : 'No permission token fee. Session access ends on lock, account change, revocation or after 30 minutes. Closing the app’s table does not revoke it.'}</p>
    <details><summary>Technical details</summary>{pending.details.map(line => <p key={line} style={{ overflowWrap: 'anywhere' }}>{line}</p>)}</details>
  </section>
}
