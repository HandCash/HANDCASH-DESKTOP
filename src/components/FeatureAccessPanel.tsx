import { useCallback, useEffect, useState } from 'react'
import { Button } from '@aeon-ui/react'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { listFeatureAccess, revokeFeatureAccess, type FeatureAccess } from '../wallet/featurePermissions'
/** Data loads and revocations run through the shared asyncActionMachine. */
export function FeatureAccessPanel() {
  const [entries, setEntries] = useState<FeatureAccess[]>([])
  const action = useAsyncAction<'load' | 'revoke'>()
  const load = useCallback(async () => { setEntries(await listFeatureAccess()) }, [])
  useEffect(() => { void action.run('load', load) }, [action.run, load])
  return <section data-aeon-scope="wallet-feature-access" data-aeon-state={action.stateAttr}>
    <h3>Wallet feature access</h3>
    <p>Session access ends on lock, account change, revocation or after 30 minutes. Remembered grants remain until revoked. Revoking a remembered grant records an on-chain change; transaction and service fees may apply.</p>
    <Button.Root variant="ghost" disabled={action.busy} onClick={() => { void action.run('load', load) }}>Refresh feature access</Button.Root>
    {action.error ? <p role="alert">{action.error}</p> : null}
    {entries.map(entry => <article key={entry.id}>
      <strong>{entry.origin}</strong><p>{entry.description}</p>
      <p>{entry.title}{entry.expiresAt ? ` · expires ${new Date(entry.expiresAt).toLocaleString()}` : ' · until revoked'}</p>
      <Button.Root variant="ghost" disabled={action.busy} onClick={() => { void action.run('revoke', async () => { await revokeFeatureAccess(entry); await load() }) }}>{entry.token ? 'Revoke remembered access' : 'End app session access'}</Button.Root>
    </article>)}
    {!entries.length && !action.busy && !action.error ? <p>No feature grants to show.</p> : null}
  </section>
}
