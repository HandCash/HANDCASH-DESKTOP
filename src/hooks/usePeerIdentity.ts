import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { IssuerBap } from '../wallet/collectableGroups'
import type { Friend } from '../wallet/friends'
import { identityCardsGeneration, peerIdentityFor, subscribeIdentityCards } from '../wallet/identityCard'
import type { IssuerIdentity } from '../wallet/issuerIdentity'
import type { Chain } from '../wallet/vault'
import { currentIssuerTrust, useIssuerIdentitiesGeneration } from './useIssuerView'

export type PeerIdentityView =
  | { kind: 'presented'; identity: IssuerIdentity; bap: IssuerBap }
  | { kind: 'missing-package'; bapId: string }

/**
 * The BAP identity a wallet key presented to this device with a signed card,
 * judged against HandCash's list and look-alike names like any issuer. With
 * `askFrom`, a contact whose package this device evicted is asked again.
 */
export function usePeerIdentity(
  chain: Chain,
  identityKey: string | null | undefined,
  askFrom?: Pick<Friend, 'identityKey' | 'messagebox'> | null,
): PeerIdentityView | null {
  const cards = useSyncExternalStore(subscribeIdentityCards, identityCardsGeneration)
  const identities = useIssuerIdentitiesGeneration()
  const view = useMemo((): PeerIdentityView | null => {
    const peer = peerIdentityFor(chain, identityKey)
    if (!peer) return null
    if (peer.kind === 'missing-package') return peer
    const { identity } = peer
    const trust = currentIssuerTrust()
    const listed = trust.listed(identity.bapId)
    const caution = listed ? null : trust.caution(identity.bapId, identity.name)
    return {
      kind: 'presented',
      identity,
      bap: {
        id: identity.bapId,
        state: 'verified',
        identity,
        ...(listed ? { listed } : {}),
        ...(caution ? { caution } : {}),
      },
    }
  }, [chain, identityKey, cards, identities])
  const missing = view?.kind === 'missing-package'
  const askKey = askFrom?.identityKey
  const askBox = askFrom?.messagebox
  useEffect(() => {
    if (!missing || !askKey) return
    void import('../wallet/identityCardShare').then(({ requestIdentityCard }) =>
      requestIdentityCard({ identityKey: askKey, messagebox: askBox }),
    )
  }, [missing, askKey, askBox])
  return view
}
