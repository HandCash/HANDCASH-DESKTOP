import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  issuerViewFor,
  type IssuerIdentityResolver,
  type IssuerView,
} from '../wallet/collectableGroups'
import { identityProfilesGeneration, subscribeIdentityProfiles } from '../wallet/identityProfiles'
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
import { requestMissingIdentitiesFromConnectedPeers } from '../wallet/deviceMesh'
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

/** Generation that changes whenever an identity, a stored profile or package, or the verified list does. */
export function useIssuerIdentitiesGeneration(): string {
  const identities = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration, publicIdentitiesGeneration)
  const profiles = useSyncExternalStore(subscribeIdentityProfiles, identityProfilesGeneration, identityProfilesGeneration)
  const packages = useSyncExternalStore(subscribeIssuerIdentities, issuerIdentitiesGeneration, issuerIdentitiesGeneration)
  const listed = useSyncExternalStore(subscribeVerifiedIssuers, verifiedIssuersGeneration, verifiedIssuersGeneration)
  useEffect(() => {
    ensureVerifiedIssuersFresh()
  }, [])
  return `${identities}:${profiles}:${packages}:${listed}`
}

/** Distinct issuers across the assets one action moves, in first-seen order. */
export function useIssuerViews(assets: readonly IssuerAsset[]): IssuerView[] {
  const generation = useIssuerIdentitiesGeneration()
  const views = useMemo(() => {
    const resolve = currentIssuerResolver()
    const trust = currentIssuerTrust()
    const out = new Map<string, IssuerView>()
    for (const { issuer, issuerAttested, bapId, origin } of assets) {
      if (!issuer) continue
      const view = issuerViewFor({ issuer, issuerAttested, bapId, origin }, resolve, trust)
      if (view && !out.has(view.key)) out.set(view.key, view)
    }
    return [...out.values()]
  }, [assets, generation])
  useEffect(() => {
    const missingKeys: string[] = []
    const missingBaps: string[] = []
    for (const v of views) {
      if (!v.profile || v.profile.state === 'unconfirmed') {
        missingKeys.push(v.identityKey)
        if (v.profile?.id && v.profile.id !== v.identityKey) missingBaps.push(v.profile.id)
      }
    }
    if (missingKeys.length > 0 || missingBaps.length > 0) {
      requestMissingIdentitiesFromConnectedPeers({ identityKeys: missingKeys, bapIds: missingBaps })
    }
  }, [views])
  return views
}

/** One asset's issuer, re-read when identities, stored packages or the verified list change. */
export function useIssuerView(asset: IssuerAsset | null): IssuerView | null {
  const generation = useIssuerIdentitiesGeneration()
  const issuer = asset?.issuer
  const issuerAttested = asset?.issuerAttested
  const bapId = asset?.bapId
  const origin = asset?.origin
  const view = useMemo(
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
  useEffect(() => {
    if (!view) return
    if (!view.profile || view.profile.state === 'unconfirmed') {
      const bapIds =
        view.profile?.id && view.profile.id !== view.identityKey ? [view.profile.id] : bapId ? [bapId] : []
      requestMissingIdentitiesFromConnectedPeers({ identityKeys: [view.identityKey], bapIds })
    }
  }, [view, bapId])
  return view
}
