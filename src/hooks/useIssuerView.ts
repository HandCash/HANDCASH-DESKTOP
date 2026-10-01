import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  issuerViewFor,
  type IssuerIdentityResolver,
  type IssuerView,
} from '../wallet/collectableGroups'
import {
  issuerIdentitiesGeneration,
  subscribeIssuerIdentities,
} from '../wallet/issuerIdentities'
import type { IssuerTrust } from '../wallet/issuerTrust'
import {
  issuerAttributionResolver,
  issuerTrustResolver,
  publicIdentitiesGeneration,
  subscribePublicIdentities,
} from '../wallet/publicIdentities'
import {
  ensureVerifiedIssuersFresh,
  subscribeVerifiedIssuers,
  verifiedIssuersGeneration,
} from '../wallet/verifiedIssuers'
import { getWalletRuntime } from '../wallet/walletRuntime'

export type IssuerAsset = {
  issuer?: string
  issuerAttested?: boolean
  bapId?: string
  /** Outpoint whose mined height judges the signer: item origin or token deploy. */
  origin?: string
}

/** Resolver bound to the current runtime, for one render pass. */
export function currentIssuerResolver(): IssuerIdentityResolver {
  return issuerAttributionResolver(getWalletRuntime())
}

/** HandCash listing and look-alike names, for one render pass. */
export function currentIssuerTrust(): IssuerTrust {
  return issuerTrustResolver(getWalletRuntime())
}

/** Generation that changes whenever an identity, a stored package or the verified list does. */
export function useIssuerIdentitiesGeneration(): string {
  const identities = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration)
  const packages = useSyncExternalStore(subscribeIssuerIdentities, issuerIdentitiesGeneration)
  const listed = useSyncExternalStore(subscribeVerifiedIssuers, verifiedIssuersGeneration)
  useEffect(() => {
    ensureVerifiedIssuersFresh()
  }, [])
  return `${identities}:${packages}:${listed}`
}

/** One asset's issuer, re-read when identities, stored packages or the verified list change. */
export function useIssuerView(asset: IssuerAsset | null): IssuerView | null {
  const generation = useIssuerIdentitiesGeneration()
  const issuer = asset?.issuer
  const issuerAttested = asset?.issuerAttested
  const bapId = asset?.bapId
  const origin = asset?.origin
  return useMemo(
    () =>
      issuer
        ? issuerViewFor(
            { issuer, issuerAttested, bapId, origin },
            currentIssuerResolver(),
            currentIssuerTrust(),
          )
        : null,
    [issuer, issuerAttested, bapId, origin, generation],
  )
}
