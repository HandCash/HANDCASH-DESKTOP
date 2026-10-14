import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { verifiedProfileMark, type IssuerProfileMark } from '../wallet/collectableGroups'
import type { Friend } from '../wallet/friends'
import { identityCardsGeneration, peerIdentityFor, subscribeIdentityCards } from '../wallet/identityCard'
import { requestIdentityCard, siblingAccountProfile } from '../wallet/identityCardShare'
import type { IssuerProfile } from '../wallet/issuerIdentity'
import type { Chain } from '../wallet/vault'
import { currentIssuerTrust, useIssuerIdentitiesGeneration } from './useIssuerView'

export type PeerIdentityView =
  | { kind: 'presented'; profile: IssuerProfile; mark: IssuerProfileMark }
  | { kind: 'missing-package'; id: string }

/**
 * The profile a wallet key presented to this device with a signed card,
 * judged against HandCash's list and look-alike names like any issuer. Another
 * account of this vault needs no card: its presented profile is read here.
 * With `askFrom`, a contact whose profile this device evicted is asked again.
 */
export function usePeerIdentity(
  chain: Chain,
  identityKey: string | null | undefined,
  askFrom?: Pick<Friend, 'identityKey' | 'messagebox'> | null,
): PeerIdentityView | null {
  const cards = useSyncExternalStore(subscribeIdentityCards, identityCardsGeneration)
  const identities = useIssuerIdentitiesGeneration()
  const view = useMemo((): PeerIdentityView | null => {
    const card = peerIdentityFor(chain, identityKey)
    if (card?.kind === 'missing-package') return card
    const profile = card?.profile ?? siblingAccountProfile(chain, identityKey)
    if (!profile) return null
    return { kind: 'presented', profile, mark: verifiedProfileMark(profile, currentIssuerTrust()) }
  }, [chain, identityKey, cards, identities])
  const missing = view?.kind === 'missing-package'
  const askKey = askFrom?.identityKey
  const askBox = askFrom?.messagebox
  useEffect(() => {
    if (!missing || !askKey) return
    void requestIdentityCard({ identityKey: askKey, messagebox: askBox })
  }, [missing, askKey, askBox])
  return view
}
