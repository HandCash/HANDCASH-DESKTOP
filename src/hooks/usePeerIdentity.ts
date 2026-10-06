import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { IssuerBap } from '../wallet/collectableGroups'
import type { Friend } from '../wallet/friends'
import { identityCardsGeneration, peerIdentityFor, subscribeIdentityCards } from '../wallet/identityCard'
import { requestIdentityCard, siblingAccountIdentity } from '../wallet/identityCardShare'
import type { IssuerIdentity } from '../wallet/issuerIdentity'
import { publicIdentitiesGeneration, subscribePublicIdentities } from '../wallet/publicIdentities'
import type { Chain } from '../wallet/vault'
import { currentIssuerTrust, useIssuerIdentitiesGeneration } from './useIssuerView'

export type PeerIdentityView =
  | { kind: 'presented'; identity: IssuerIdentity; bap: IssuerBap }
  | { kind: 'missing-package'; bapId: string }

/**
 * The BAP identity a wallet key presented to this device with a signed card,
 * judged against HandCash's list and look-alike names like any issuer. Another
 * account of this vault needs no card: its presented identity is read here.
 * With `askFrom`, a contact whose package this device evicted is asked again.
 */
export function usePeerIdentity(
  chain: Chain,
  identityKey: string | null | undefined,
  askFrom?: Pick<Friend, 'identityKey' | 'messagebox'> | null,
): PeerIdentityView | null {
  const cards = useSyncExternalStore(subscribeIdentityCards, identityCardsGeneration)
  const own = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration)
  const identities = useIssuerIdentitiesGeneration()
  const view = useMemo((): PeerIdentityView | null => {
    const card = peerIdentityFor(chain, identityKey)
    if (card?.kind === 'missing-package') return card
    const identity = card?.identity ?? siblingAccountIdentity(chain, identityKey)
    if (!identity) return null
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
  }, [chain, identityKey, cards, own, identities])
  const missing = view?.kind === 'missing-package'
  const askKey = askFrom?.identityKey
  const askBox = askFrom?.messagebox
  useEffect(() => {
    if (!missing || !askKey) return
    void requestIdentityCard({ identityKey: askKey, messagebox: askBox })
  }, [missing, askKey, askBox])
  return view
}
